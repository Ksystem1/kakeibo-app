/**
 * Stripe Webhook: families（家族単位）の subscription_status / stripe_customer_id を同期
 *
 * 処理イベント:
 * - customer.subscription.created / updated → Stripe Subscription.status を DB に反映（同じ family の全員が参照）
 * - customer.subscription.deleted → subscription_status = canceled
 * - checkout.session.completed → metadata / client_reference_id でユーザを特定し、その家族に cus_ を紐付け
 */
import Stripe from "stripe";
import { createLogger } from "./logger.mjs";
import { getStripeWebhookSecret, requireStripeSecretKey } from "./stripe-config.mjs";
import { mapStripeSubscriptionStatusToDb } from "./subscription-logic.mjs";

const logger = createLogger("stripe-webhook");

/**
 * @param {Buffer|string} payload
 * @param {string|undefined} sigHeader
 * @param {import("mysql2/promise").Pool} pool
 */
export async function processStripeWebhook(payload, sigHeader, pool) {
  const secret = getStripeWebhookSecret();
  if (!secret) {
    return {
      ok: false,
      statusCode: 503,
      body: {
        error: "StripeWebhookNotConfigured",
        detail:
          "STRIPE_WEBHOOK_SECRET（または STRIPE_TEST_WEBHOOK_SECRET）を設定してください（Stripe ダッシュボードの Webhook 署名シークレット whsec_...）",
      },
    };
  }

  if (!sigHeader || String(sigHeader).trim() === "") {
    return {
      ok: false,
      statusCode: 400,
      body: { error: "MissingStripeSignature" },
    };
  }

  let event;
  try {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
    event = Stripe.webhooks.constructEvent(buf, sigHeader, secret);
  } catch (e) {
    logger.warn("stripe.signature_invalid", { message: String(e?.message || e) });
    return {
      ok: false,
      statusCode: 400,
      body: { error: "InvalidSignature" },
    };
  }

  logger.info("stripe.event_received", {
    type: event.type,
    id: event.id,
    livemode: event.livemode,
  });

  try {
    switch (event.type) {
      case "customer.subscription.updated":
      case "customer.subscription.created":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await syncSubscriptionToFamily(pool, sub, event.type === "customer.subscription.deleted");
        break;
      }
      case "checkout.session.completed": {
        const session = event.data.object;
        await linkStripeCustomerFromCheckout(pool, session);
        break;
      }
      default:
        logger.info("stripe.event_unhandled", { type: event.type });
    }
  } catch (e) {
    logger.error("stripe.handler_error", e, { type: event.type });
    return {
      ok: false,
      statusCode: 500,
      body: { error: "WebhookHandlerError", detail: String(e?.message || e) },
    };
  }

  return { ok: true, statusCode: 200, body: { received: true } };
}

/** @param {Record<string, unknown>} subscription */
async function syncSubscriptionToFamily(pool, subscription, deleted) {
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer && typeof subscription.customer === "object"
        ? subscription.customer.id
        : null;
  if (!customerId) {
    logger.warn("stripe.subscription_no_customer", { id: subscription.id });
    return;
  }

  const dbStatus = deleted
    ? "canceled"
    : mapStripeSubscriptionStatusToDb(subscription.status);

  const periodEndUnix = deleted
    ? Number(subscription.ended_at ?? subscription.current_period_end ?? 0) || null
    : Number(subscription.current_period_end ?? 0) || null;
  const periodEndDate =
    periodEndUnix != null && periodEndUnix > 0
      ? new Date(periodEndUnix * 1000)
      : null;
  const cancelAtEnd = deleted ? 0 : subscription.cancel_at_period_end ? 1 : 0;
  const subId =
    typeof subscription.id === "string"
      ? subscription.id
      : subscription.id != null
        ? String(subscription.id)
        : null;

  const [res] = await pool.query(
    `UPDATE families SET subscription_status = ?, subscription_period_end_at = ?, subscription_cancel_at_period_end = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id), updated_at = NOW() WHERE stripe_customer_id = ?`,
    [dbStatus, periodEndDate, cancelAtEnd, subId, customerId],
  );
  if (res.affectedRows) return;

  const [[legacy]] = await pool.query(
    `SELECT COALESCE(u.default_family_id, (SELECT fm.family_id FROM family_members fm WHERE fm.user_id = u.id ORDER BY fm.id LIMIT 1)) AS fid
     FROM users u WHERE u.stripe_customer_id = ? LIMIT 1`,
    [customerId],
  );
  const fid = legacy?.fid != null ? Number(legacy.fid) : null;
  if (fid && Number.isFinite(fid) && fid > 0) {
    await pool.query(
      `UPDATE families SET
         subscription_status = ?,
         subscription_period_end_at = ?,
         subscription_cancel_at_period_end = ?,
         stripe_subscription_id = COALESCE(?, stripe_subscription_id),
         stripe_customer_id = COALESCE(stripe_customer_id, ?),
         updated_at = NOW()
       WHERE id = ?`,
      [dbStatus, periodEndDate, cancelAtEnd, subId, customerId, fid],
    );
    return;
  }

  logger.warn("stripe.subscription_no_family_for_customer", {
    customerId,
    subscriptionId: subscription.id,
  });
}

/** Checkout 完了時: metadata.kakeibo_user_id または client_reference_id でユーザーを特定し、その家族に cus_ を保存 */
async function linkStripeCustomerFromCheckout(pool, session) {
  const meta = session.metadata && typeof session.metadata === "object" ? session.metadata : {};
  const rawId = meta.kakeibo_user_id ?? meta.user_id ?? session.client_reference_id;
  const userId = rawId != null ? Number(String(rawId).trim()) : NaN;
  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer && typeof session.customer === "object"
        ? session.customer.id
        : null;

  if (!Number.isFinite(userId) || userId <= 0 || !customerId) {
    logger.warn("stripe.checkout_missing_link", {
      sessionId: session.id,
      hasCustomer: Boolean(customerId),
      rawUserId: rawId ?? null,
    });
    return;
  }

  const subId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription && typeof session.subscription === "object"
        ? session.subscription.id
        : null;
  const subIdStr =
    subId != null && String(subId).trim() !== "" ? String(subId).trim() : null;

  const ps = String(session.payment_status || "");
  const paidComplete =
    session.mode === "subscription" &&
    session.status === "complete" &&
    (ps === "paid" || ps === "no_payment_required");

  const [[ur]] = await pool.query(
    `SELECT COALESCE(u.default_family_id, (SELECT fm.family_id FROM family_members fm WHERE fm.user_id = u.id ORDER BY fm.id LIMIT 1)) AS fid
     FROM users u WHERE u.id = ?`,
    [userId],
  );
  const fid = ur?.fid != null ? Number(ur.fid) : null;

  if (fid && Number.isFinite(fid) && fid > 0) {
    await pool.query(
      `UPDATE families SET stripe_customer_id = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id), updated_at = NOW() WHERE id = ?`,
      [customerId, subIdStr, fid],
    );

    if (paidComplete && subIdStr) {
      try {
        const stripe = new Stripe(requireStripeSecretKey());
        const sub = await stripe.subscriptions.retrieve(subIdStr);
        await syncSubscriptionToFamily(pool, sub, false);
      } catch (e) {
        logger.warn("stripe.checkout_subscription_sync_failed", {
          message: String(e?.message || e),
          userId,
          subIdStr,
        });
        await pool.query(
          `UPDATE families SET subscription_status = 'active', updated_at = NOW() WHERE id = ?`,
          [fid],
        );
      }
    } else if (paidComplete) {
      await pool.query(
        `UPDATE families SET subscription_status = 'active', updated_at = NOW() WHERE id = ?`,
        [fid],
      );
    }
    return;
  }

  await pool.query(
    `UPDATE users SET stripe_customer_id = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id), updated_at = NOW() WHERE id = ?`,
    [customerId, subIdStr, userId],
  );

  if (paidComplete && subIdStr) {
    try {
      const stripe = new Stripe(requireStripeSecretKey());
      const sub = await stripe.subscriptions.retrieve(subIdStr);
      await syncSubscriptionToFamily(pool, sub, false);
    } catch (e) {
      logger.warn("stripe.checkout_subscription_sync_failed", {
        message: String(e?.message || e),
        userId,
        subIdStr,
      });
      await pool.query(
        `UPDATE users SET subscription_status = 'active', updated_at = NOW() WHERE id = ?`,
        [userId],
      );
    }
  } else if (paidComplete) {
    await pool.query(
      `UPDATE users SET subscription_status = 'active', updated_at = NOW() WHERE id = ?`,
      [userId],
    );
  }
}
