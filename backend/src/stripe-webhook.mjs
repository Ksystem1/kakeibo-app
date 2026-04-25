/**
 * Stripe Webhook: families（家族単位）の subscription_status / stripe_customer_id を同期
 *
 * エンドポイント: POST /webhooks/stripe, POST /api/webhooks/stripe
 *
 * 処理イベント:
 * - customer.subscription.created / updated → Stripe Subscription.status を DB に反映
 * - customer.subscription.deleted → families を canceled 相当に更新し、該当家族配下 users の is_premium を 0 に戻す
 *   （users.is_premium=1 だけが derive で active 扱いになる不整合の防止。管理者付与 admin_free は触らない）
 * - checkout.session.completed → metadata / client_reference_id でユーザを特定し、その家族に cus_ を紐付け
 */
import Stripe from "stripe";
import { createLogger } from "./logger.mjs";
import { getStripeWebhookSecret, requireStripeSecretKey } from "./stripe-config.mjs";
import { mapStripeSubscriptionStatusToDb } from "./subscription-logic.mjs";
import { clearIsPremiumAfterSubscriptionEndedDb } from "./stripe-user-premium-sync.mjs";

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
        await logSaleFromCheckoutSession(pool, event.id, session);
        break;
      }
      case "invoice.paid": {
        const invoice = event.data.object;
        await logSaleFromInvoicePaid(pool, event.id, invoice);
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

const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

function normalizeAmountToDecimal(amountMinorUnit, currency) {
  const n = Number(amountMinorUnit);
  if (!Number.isFinite(n)) return null;
  const code = String(currency || "").trim().toLowerCase();
  return ZERO_DECIMAL_CURRENCIES.has(code) ? n : n / 100;
}

async function insertSaleLog(pool, row) {
  try {
    await pool.query(
      `INSERT INTO sales_logs
       (stripe_event_id, stripe_source_type, stripe_source_id, user_id, family_id, currency,
        gross_amount, stripe_fee_amount, net_amount, occurred_at, raw_payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
        user_id = VALUES(user_id),
        family_id = VALUES(family_id),
        currency = VALUES(currency),
        gross_amount = VALUES(gross_amount),
        stripe_fee_amount = VALUES(stripe_fee_amount),
        net_amount = VALUES(net_amount),
        occurred_at = VALUES(occurred_at),
        raw_payload_json = VALUES(raw_payload_json),
        updated_at = NOW()`,
      [
        row.stripeEventId,
        row.stripeSourceType,
        row.stripeSourceId,
        row.userId ?? null,
        row.familyId ?? null,
        row.currency,
        row.grossAmount,
        row.stripeFeeAmount,
        row.netAmount,
        row.occurredAt,
        JSON.stringify(row.rawPayload ?? {}),
      ],
    );
  } catch (e) {
    const errno = Number(e?.errno);
    const code = String(e?.code || "");
    if (errno === 1146 || code === "ER_NO_SUCH_TABLE") {
      logger.warn("stripe.sales_logs_table_missing", {
        detail: "sales_logs テーブルが未作成のため売上ログ保存をスキップしました",
      });
      return;
    }
    throw e;
  }
}

async function resolveUserAndFamilyForSaleLog(pool, rawUserId, customerId) {
  const parsedUserId = Number(rawUserId);
  const directUserId = Number.isFinite(parsedUserId) && parsedUserId > 0 ? Math.trunc(parsedUserId) : null;
  if (directUserId) {
    const [[row]] = await pool.query(
      `SELECT u.id AS user_id,
              COALESCE(u.default_family_id, (SELECT fm.family_id FROM family_members fm WHERE fm.user_id = u.id ORDER BY fm.id LIMIT 1)) AS family_id
       FROM users u
       WHERE u.id = ?
       LIMIT 1`,
      [directUserId],
    );
    if (row?.user_id != null) {
      return {
        userId: Number(row.user_id),
        familyId: row.family_id != null ? Number(row.family_id) : null,
      };
    }
  }
  const customer = String(customerId || "").trim();
  if (!customer) return { userId: null, familyId: null };
  const [[rowByFamily]] = await pool.query(
    `SELECT f.id AS family_id,
            (SELECT fm.user_id FROM family_members fm WHERE fm.family_id = f.id ORDER BY (fm.role = 'owner') DESC, fm.id ASC LIMIT 1) AS user_id
     FROM families f
     WHERE TRIM(COALESCE(f.stripe_customer_id, '')) = ?
     LIMIT 1`,
    [customer],
  );
  if (rowByFamily?.family_id != null) {
    return {
      userId: rowByFamily.user_id != null ? Number(rowByFamily.user_id) : null,
      familyId: Number(rowByFamily.family_id),
    };
  }
  return { userId: null, familyId: null };
}

async function extractPaymentAmountsByPaymentIntent(paymentIntentId) {
  if (!paymentIntentId) return null;
  const stripe = new Stripe(requireStripeSecretKey());
  const pi = await stripe.paymentIntents.retrieve(String(paymentIntentId), {
    expand: ["latest_charge.balance_transaction"],
  });
  const bt =
    pi.latest_charge &&
    typeof pi.latest_charge === "object" &&
    pi.latest_charge.balance_transaction &&
    typeof pi.latest_charge.balance_transaction === "object"
      ? pi.latest_charge.balance_transaction
      : null;
  if (!bt) return null;
  const ccy = String(bt.currency || "jpy").toLowerCase();
  const gross = normalizeAmountToDecimal(bt.amount, ccy);
  const fee = normalizeAmountToDecimal(bt.fee, ccy);
  const net = normalizeAmountToDecimal(bt.net, ccy);
  if (gross == null || fee == null || net == null) return null;
  return {
    grossAmount: gross,
    stripeFeeAmount: fee,
    netAmount: net,
    currency: ccy,
    occurredAt:
      bt.created != null && Number.isFinite(Number(bt.created))
        ? new Date(Number(bt.created) * 1000)
        : null,
  };
}

async function extractPaymentAmountsByCharge(chargeId) {
  if (!chargeId) return null;
  const stripe = new Stripe(requireStripeSecretKey());
  const charge = await stripe.charges.retrieve(String(chargeId), {
    expand: ["balance_transaction"],
  });
  const bt =
    charge.balance_transaction && typeof charge.balance_transaction === "object"
      ? charge.balance_transaction
      : null;
  if (!bt) return null;
  const ccy = String(bt.currency || charge.currency || "jpy").toLowerCase();
  const gross = normalizeAmountToDecimal(bt.amount, ccy);
  const fee = normalizeAmountToDecimal(bt.fee, ccy);
  const net = normalizeAmountToDecimal(bt.net, ccy);
  if (gross == null || fee == null || net == null) return null;
  return {
    grossAmount: gross,
    stripeFeeAmount: fee,
    netAmount: net,
    currency: ccy,
    occurredAt:
      bt.created != null && Number.isFinite(Number(bt.created))
        ? new Date(Number(bt.created) * 1000)
        : null,
  };
}

async function logSaleFromCheckoutSession(pool, stripeEventId, session) {
  const paymentStatus = String(session?.payment_status || "");
  if (paymentStatus !== "paid") return;
  const sourceId = String(session?.id || "").trim();
  if (!sourceId) return;
  const rawMeta =
    session?.metadata && typeof session.metadata === "object" ? session.metadata : {};
  const rawUserId =
    rawMeta.kakeibo_user_id ?? rawMeta.user_id ?? session?.client_reference_id ?? null;
  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer && typeof session.customer === "object"
        ? session.customer.id
        : null;
  const userAndFamily = await resolveUserAndFamilyForSaleLog(pool, rawUserId, customerId);
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent && typeof session.payment_intent === "object"
        ? session.payment_intent.id
        : null;
  const amountByBt = await extractPaymentAmountsByPaymentIntent(paymentIntentId);
  const currency = String(amountByBt?.currency ?? session.currency ?? "jpy").toLowerCase();
  const grossFallback = normalizeAmountToDecimal(session.amount_total, currency);
  const grossAmount = amountByBt?.grossAmount ?? grossFallback ?? 0;
  const stripeFeeAmount = amountByBt?.stripeFeeAmount ?? 0;
  const netAmount = amountByBt?.netAmount ?? grossAmount - stripeFeeAmount;
  const occurredAt =
    amountByBt?.occurredAt ??
    (session.created != null && Number.isFinite(Number(session.created))
      ? new Date(Number(session.created) * 1000)
      : new Date());
  await insertSaleLog(pool, {
    stripeEventId,
    stripeSourceType: "checkout_session",
    stripeSourceId: sourceId,
    userId: userAndFamily.userId,
    familyId: userAndFamily.familyId,
    currency,
    grossAmount,
    stripeFeeAmount,
    netAmount,
    occurredAt,
    rawPayload: {
      id: session.id,
      mode: session.mode,
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      currency: session.currency,
      payment_intent: paymentIntentId,
      customer: customerId,
    },
  });
}

async function logSaleFromInvoicePaid(pool, stripeEventId, invoice) {
  const sourceId = String(invoice?.id || "").trim();
  if (!sourceId) return;
  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer && typeof invoice.customer === "object"
        ? invoice.customer.id
        : null;
  const rawMeta =
    invoice?.metadata && typeof invoice.metadata === "object" ? invoice.metadata : {};
  const rawUserId = rawMeta.kakeibo_user_id ?? rawMeta.user_id ?? null;
  const userAndFamily = await resolveUserAndFamilyForSaleLog(pool, rawUserId, customerId);
  const chargeId =
    typeof invoice.charge === "string"
      ? invoice.charge
      : invoice.charge && typeof invoice.charge === "object"
        ? invoice.charge.id
        : null;
  const amountByBt = await extractPaymentAmountsByCharge(chargeId);
  const currency = String(amountByBt?.currency ?? invoice.currency ?? "jpy").toLowerCase();
  const grossFallback = normalizeAmountToDecimal(invoice.amount_paid, currency);
  const grossAmount = amountByBt?.grossAmount ?? grossFallback ?? 0;
  const stripeFeeAmount = amountByBt?.stripeFeeAmount ?? 0;
  const netAmount = amountByBt?.netAmount ?? grossAmount - stripeFeeAmount;
  const occurredAt =
    amountByBt?.occurredAt ??
    (invoice.status_transitions?.paid_at != null &&
    Number.isFinite(Number(invoice.status_transitions.paid_at))
      ? new Date(Number(invoice.status_transitions.paid_at) * 1000)
      : invoice.created != null && Number.isFinite(Number(invoice.created))
        ? new Date(Number(invoice.created) * 1000)
        : new Date());
  await insertSaleLog(pool, {
    stripeEventId,
    stripeSourceType: "invoice",
    stripeSourceId: sourceId,
    userId: userAndFamily.userId,
    familyId: userAndFamily.familyId,
    currency,
    grossAmount,
    stripeFeeAmount,
    netAmount,
    occurredAt,
    rawPayload: {
      id: invoice.id,
      subscription: invoice.subscription ?? null,
      amount_paid: invoice.amount_paid,
      currency: invoice.currency,
      charge: chargeId,
      customer: customerId,
    },
  });
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

  let familyIdTouched = null;
  const [res] = await pool.query(
    `UPDATE families SET subscription_status = ?, subscription_period_end_at = ?, subscription_cancel_at_period_end = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id), updated_at = NOW() WHERE stripe_customer_id = ?`,
    [dbStatus, periodEndDate, cancelAtEnd, subId, customerId],
  );
  if (res.affectedRows) {
    const [[frow]] = await pool.query(`SELECT id FROM families WHERE TRIM(COALESCE(stripe_customer_id, '')) = ? LIMIT 1`, [
      String(customerId).trim(),
    ]);
    if (frow?.id != null) {
      familyIdTouched = Number(frow.id);
    }
  } else {
    /** users.stripe_customer_id を削除済みの DB では ER_BAD_FIELD になるためスキップ */
    let fid = null;
    try {
      const [[legacy]] = await pool.query(
        `SELECT COALESCE(u.default_family_id, (SELECT fm.family_id FROM family_members fm WHERE fm.user_id = u.id ORDER BY fm.id LIMIT 1)) AS fid
         FROM users u WHERE u.stripe_customer_id = ? LIMIT 1`,
        [customerId],
      );
      fid = legacy?.fid != null ? Number(legacy.fid) : null;
    } catch (e) {
      const code = String(e?.code || "");
      const errno = Number(e?.errno);
      if (code !== "ER_BAD_FIELD_ERROR" && errno !== 1054) throw e;
    }
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
      familyIdTouched = fid;
    }
  }

  if (!familyIdTouched) {
    logger.warn("stripe.subscription_no_family_for_customer", {
      customerId,
      subscriptionId: subscription.id,
    });
  }

  if (deleted) {
    await clearIsPremiumAfterSubscriptionEndedDb(
      pool,
      { familyId: familyIdTouched, customerId: String(customerId) },
      { subscriptionId: subId, event: "customer.subscription.deleted" },
    );
  }
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

  /** 家族未設定かつ users に Stripe 列が無い環境ではここは失敗する（通常は default_family あり） */
  try {
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
  } catch (e) {
    const errno = Number(e?.errno);
    if (errno === 1054) {
      logger.warn("stripe.checkout_users_columns_missing_or_no_family", {
        userId,
        detail:
          "所属家族が無いか、users から Stripe 列を削除済みです。families への紐付けを確認してください。",
      });
      return;
    }
    throw e;
  }
}
