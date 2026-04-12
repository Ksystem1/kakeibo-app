/**
 * Stripe Webhook: users.subscription_status / stripe_customer_id を同期
 *
 * 処理イベント:
 * - customer.subscription.created / updated → Stripe Subscription.status を DB に反映
 * - customer.subscription.deleted → subscription_status = canceled（管理画面では「解約済み」）
 * - checkout.session.completed → metadata / client_reference_id でユーザと cus_ を紐付け
 */
import Stripe from "stripe";
import { createLogger } from "./logger.mjs";
import { getStripeWebhookSecret } from "./stripe-config.mjs";
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
        await syncSubscriptionToUser(pool, sub, event.type === "customer.subscription.deleted");
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
async function syncSubscriptionToUser(pool, subscription, deleted) {
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

  const [res] = await pool.query(
    `UPDATE users SET subscription_status = ?, updated_at = NOW() WHERE stripe_customer_id = ?`,
    [dbStatus, customerId],
  );
  if (!res.affectedRows) {
    logger.warn("stripe.subscription_no_user_for_customer", {
      customerId,
      subscriptionId: subscription.id,
    });
  }
}

/** Checkout 完了時: metadata.kakeibo_user_id または client_reference_id でユーザーを特定し cus_ を保存 */
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

  let setSubscriptionStatus = false;
  let dbStatus = "inactive";
  if (session.mode === "subscription" && session.status === "complete") {
    const ps = String(session.payment_status || "");
    if (ps === "paid" || ps === "no_payment_required") {
      setSubscriptionStatus = true;
      dbStatus = "active";
    }
  }

  if (setSubscriptionStatus) {
    await pool.query(
      `UPDATE users SET stripe_customer_id = ?, subscription_status = ?, updated_at = NOW() WHERE id = ?`,
      [customerId, dbStatus, userId],
    );
  } else {
    await pool.query(
      `UPDATE users SET stripe_customer_id = ?, updated_at = NOW() WHERE id = ?`,
      [customerId, userId],
    );
  }
}
