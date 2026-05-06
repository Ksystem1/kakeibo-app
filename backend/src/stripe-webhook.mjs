/**
 * Stripe Webhook: families（家族単位）の subscription_status / stripe_customer_id を同期
 *
 * エンドポイント: POST /webhooks/stripe, POST /api/webhooks/stripe, POST /api/stripe/webhook（別名）
 *
 * 処理イベント:
 * - customer.subscription.created / updated → Stripe Subscription.status を DB に反映
 * - customer.subscription.deleted → families を canceled 相当に更新し、該当家族配下 users の is_premium を 0 に戻す
 *   （users.is_premium=1 だけが derive で active 扱いになる不整合の防止。管理者付与 admin_free は触らない）
 * - checkout.session.completed / checkout.session.async_payment_succeeded → 同上（後者は遅延決済完了時）
 *   metadata / client_reference_id でユーザを特定し、その家族に cus_ を紐付け、Subscription を DB 同期
 *   （家族 ID は /auth/me と同じ sqlUserFamilyIdExpr で解決。subscription.* が checkout より先に届いた場合は Subscription の metadata.kakeibo_user_id で families を更新）
 */
import Stripe from "stripe";
import { createLogger } from "./logger.mjs";
import { sqlUserFamilyIdExpr } from "./family-billing-scope.mjs";
import { getStripeWebhookSecret, requireStripeSecretKey } from "./stripe-config.mjs";
import { mapStripeSubscriptionStatusToDb } from "./subscription-logic.mjs";
import { clearIsPremiumAfterSubscriptionEndedDb } from "./stripe-user-premium-sync.mjs";
import { applyEstimatedFeeIfZero } from "./stripe-sales-fee-estimate.mjs";

const logger = createLogger("stripe-webhook");

/** ECS の環境変数 STRIPE_WEBHOOK_DEBUG_LOG=1 または true で DB 更新の affectedRows 等を追加ログ */
function webhookVerbose(payload) {
  const v = String(process.env.STRIPE_WEBHOOK_DEBUG_LOG ?? "").trim().toLowerCase();
  if (v !== "1" && v !== "true" && v !== "yes") return;
  logger.info("stripe.webhook_verbose", payload);
}

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
  webhookVerbose({
    step: "event_received",
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
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
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
      case "refund.created":
      case "refund.updated": {
        const ref = event.data.object;
        if (String(ref.status) === "succeeded") {
          await logSaleFromRefund(pool, event.id, ref);
        }
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

/**
 * Charge/Customer 支払額（gross）と入金額（net）から手数料を一貫させる。
 * BT 単体の `fee` だけに依存すると、テスト環境等で total=fee, net=0 になり
 * 実務的な水準と合わないことがあるため、必要なら gross - net を優先する。
 */
function deriveGrossFeeNetFromBalanceTransaction(bt, ccy, options = {}) {
  const { chargeAmountMinor } = options;
  const net = normalizeAmountToDecimal(bt.net, ccy);
  if (net == null) return null;
  const rawFee = normalizeAmountToDecimal(bt.fee, ccy);
  const btGross = normalizeAmountToDecimal(bt.amount, ccy);
  if (btGross == null) return null;
  const chargeGross =
    chargeAmountMinor != null && chargeAmountMinor !== "" && Number.isFinite(Number(chargeAmountMinor))
      ? normalizeAmountToDecimal(Number(chargeAmountMinor), ccy)
      : null;
  const gross = chargeGross != null ? chargeGross : btGross;
  if (gross == null) return null;
  const impliedFee = gross - net;
  let stripeFeeAmount = rawFee;
  if (rawFee == null) {
    stripeFeeAmount = impliedFee;
  } else if (Math.abs(rawFee - impliedFee) > 0.5) {
    logger.info("stripe.sales_fee_reconciled_to_implied", {
      currency: ccy,
      impliedFee,
      rawFee,
    });
    stripeFeeAmount = impliedFee;
  } else {
    stripeFeeAmount = rawFee;
  }
  if (gross > 0 && net >= 0) {
    if (stripeFeeAmount < 0) stripeFeeAmount = impliedFee;
    if (stripeFeeAmount > gross) stripeFeeAmount = impliedFee;
  } else if (gross < 0 && net <= 0) {
    if (stripeFeeAmount > 0 && impliedFee < 0) stripeFeeAmount = impliedFee;
    if (stripeFeeAmount < gross) stripeFeeAmount = impliedFee;
  }
  return {
    grossAmount: gross,
    stripeFeeAmount,
    netAmount: net,
    currency: ccy,
    occurredAt:
      bt.created != null && Number.isFinite(Number(bt.created))
        ? new Date(Number(bt.created) * 1000)
        : null,
  };
}

async function extractPaymentAmountsByPaymentIntent(paymentIntentId) {
  if (!paymentIntentId) return null;
  const stripe = new Stripe(requireStripeSecretKey());
  const pi = await stripe.paymentIntents.retrieve(String(paymentIntentId), {
    expand: ["latest_charge.balance_transaction", "latest_charge"],
  });
  const lc = pi.latest_charge;
  let chargeObj = null;
  if (typeof lc === "string" && lc.trim() !== "") {
    chargeObj = await stripe.charges.retrieve(lc, { expand: ["balance_transaction"] });
  } else if (lc && typeof lc === "object") {
    chargeObj = lc;
  }
  if (!chargeObj) return null;
  let bt = null;
  if (chargeObj.balance_transaction && typeof chargeObj.balance_transaction === "object") {
    bt = chargeObj.balance_transaction;
  } else if (typeof chargeObj.balance_transaction === "string" && chargeObj.balance_transaction) {
    bt = await stripe.balanceTransactions.retrieve(String(chargeObj.balance_transaction));
  } else {
    return null;
  }
  if (!bt) return null;
  const ccy = String(bt.currency || "jpy").toLowerCase();
  const chMinor = "amount" in chargeObj && chargeObj.amount != null ? chargeObj.amount : pi?.amount;
  return deriveGrossFeeNetFromBalanceTransaction(bt, ccy, { chargeAmountMinor: chMinor });
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
  return deriveGrossFeeNetFromBalanceTransaction(bt, ccy, { chargeAmountMinor: charge.amount });
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
  const est = applyEstimatedFeeIfZero({
    gross: grossAmount,
    fee: stripeFeeAmount,
    net: netAmount,
    currency,
  });
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
    grossAmount: est.gross,
    stripeFeeAmount: est.fee,
    netAmount: est.net,
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
  const estI = applyEstimatedFeeIfZero({
    gross: grossAmount,
    fee: stripeFeeAmount,
    net: netAmount,
    currency,
  });
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
    grossAmount: estI.gross,
    stripeFeeAmount: estI.fee,
    netAmount: estI.net,
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

/**
 * 返金: 返金1件あたり1行。金額は原則負数（売上減少・入金戻し）で sales_logs に積算される。
 */
async function logSaleFromRefund(pool, stripeEventId, refund) {
  if (String(refund?.status) !== "succeeded") return;
  const id = String(refund?.id ?? "").trim();
  if (!id) return;
  const stripe = new Stripe(requireStripeSecretKey());
  const rf = await stripe.refunds.retrieve(String(id), {
    expand: ["balance_transaction", "charge"],
  });
  if (String(rf.status) !== "succeeded") return;
  let bt = null;
  if (rf.balance_transaction && typeof rf.balance_transaction === "object") {
    bt = rf.balance_transaction;
  } else if (typeof rf.balance_transaction === "string" && rf.balance_transaction) {
    bt = await stripe.balanceTransactions.retrieve(String(rf.balance_transaction));
  }
  if (!bt) {
    logger.warn("stripe.refund_no_balance_transaction", { refundId: rf.id });
    return;
  }
  const ccy = String(bt.currency || "jpy").toLowerCase();
  const amountByBt = deriveGrossFeeNetFromBalanceTransaction(bt, ccy, {});
  if (!amountByBt) return;
  const ch = typeof rf.charge === "object" && rf.charge ? rf.charge : null;
  const customerId = ch
    ? typeof ch.customer === "string"
      ? ch.customer
      : ch.customer && typeof ch.customer === "object"
        ? ch.customer.id
        : null
    : null;
  const userAndFamily = await resolveUserAndFamilyForSaleLog(pool, null, customerId);
  const occurredAt = amountByBt.occurredAt ?? new Date();
  const estR = applyEstimatedFeeIfZero({
    gross: amountByBt.grossAmount,
    fee: amountByBt.stripeFeeAmount,
    net: amountByBt.netAmount,
    currency: amountByBt.currency,
  });
  await insertSaleLog(pool, {
    stripeEventId,
    stripeSourceType: "refund",
    stripeSourceId: String(rf.id),
    userId: userAndFamily.userId,
    familyId: userAndFamily.familyId,
    currency: amountByBt.currency,
    grossAmount: estR.gross,
    stripeFeeAmount: estR.fee,
    netAmount: estR.net,
    occurredAt,
    rawPayload: {
      id: rf.id,
      charge: typeof rf.charge === "string" ? rf.charge : ch?.id ?? null,
      amount: rf.amount,
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
  let legacyUpdateRows = null;
  let metadataFallbackRows = null;
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
      const [legacyUpd] = await pool.query(
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
      legacyUpdateRows = Number(legacyUpd?.affectedRows ?? 0);
      familyIdTouched = fid;
    }
  }

  /** checkout より先に subscription.* が届いた場合、まだ families.stripe_customer_id が無いと上記は 0 行。Checkout が付ける metadata でユーザーを引き、請求対象の家族行を更新する */
  if (!familyIdTouched) {
    const meta =
      subscription.metadata && typeof subscription.metadata === "object"
        ? subscription.metadata
        : {};
    const rawUid = meta.kakeibo_user_id ?? meta.user_id;
    const metaUid =
      rawUid != null
        ? Number(String(rawUid).trim())
        : NaN;
    if (Number.isFinite(metaUid) && metaUid > 0) {
      const famExpr = sqlUserFamilyIdExpr("u");
      const [[urow]] = await pool.query(
        `SELECT (${famExpr}) AS fid FROM users u WHERE u.id = ? LIMIT 1`,
        [Math.trunc(metaUid)],
      );
      const mfid = urow?.fid != null ? Number(urow.fid) : null;
      if (mfid && Number.isFinite(mfid) && mfid > 0) {
        const [metaUpd] = await pool.query(
          `UPDATE families SET
           subscription_status = ?,
           subscription_period_end_at = ?,
           subscription_cancel_at_period_end = ?,
           stripe_subscription_id = COALESCE(?, stripe_subscription_id),
           stripe_customer_id = COALESCE(NULLIF(TRIM(COALESCE(stripe_customer_id, '')), ''), ?),
           updated_at = NOW()
           WHERE id = ?`,
          [dbStatus, periodEndDate, cancelAtEnd, subId, customerId, mfid],
        );
        const mr = Number(metaUpd?.affectedRows ?? 0);
        if (mr > 0) {
          familyIdTouched = mfid;
          metadataFallbackRows = mr;
          logger.info("stripe.subscription_sync_via_subscription_metadata", {
            userId: Math.trunc(metaUid),
            familyId: mfid,
            customerIdPrefix: String(customerId).slice(0, 14),
            affectedRows: mr,
          });
        }
      }
    }
  }

  logger.info("stripe.subscription_sync_db", {
    stripeSubscriptionId: subId,
    dbStatus,
    deleted,
    familiesFirstUpdateRows: Number(res?.affectedRows ?? 0),
    familiesLegacyUpdateRows: legacyUpdateRows,
    familiesMetadataFallbackRows: metadataFallbackRows,
    familyIdTouched: familyIdTouched ?? null,
    customerIdPrefix: String(customerId).slice(0, 14),
  });

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

/**
 * Checkout 後、Stripe Subscription を DB に同期。
 * 旧実装は payment_status が paid になるまで retrieve をスキップしていたため、
 * 一瞬 unpaid のセッションで契約状態が families に载らないことがあった。
 * subscription ID がある complete セッションでは常に同期する。
 */
async function syncCheckoutSessionSubscription(pool, opts) {
  const { fid, userId, subIdStr, session, target } = opts;
  const ps = String(session.payment_status || "");
  const paidComplete =
    session.mode === "subscription" &&
    session.status === "complete" &&
    (ps === "paid" || ps === "no_payment_required");

  const hasSubForSync =
    Boolean(subIdStr) &&
    session.mode === "subscription" &&
    String(session.status || "").trim() === "complete";

  webhookVerbose({
    step: "sync_checkout_subscription_enter",
    target,
    userId,
    fid: fid ?? null,
    sessionMode: session.mode,
    sessionStatus: session.status,
    paymentStatus: ps || null,
    hasSubForSync,
    paidComplete,
    subscriptionIdPrefix: subIdStr ? String(subIdStr).slice(0, 18) : null,
  });

  if (hasSubForSync) {
    try {
      const stripe = new Stripe(requireStripeSecretKey());
      const sub = await stripe.subscriptions.retrieve(subIdStr);
      await syncSubscriptionToFamily(pool, sub, false);
      logger.info("stripe.checkout_subscription_synced", {
        userId,
        fid: fid ?? null,
        subscriptionId: subIdStr,
        stripeStatus: sub.status,
        paymentStatus: ps || null,
      });
      return;
    } catch (e) {
      logger.warn("stripe.checkout_subscription_sync_failed", {
        message: String(e?.message || e),
        userId,
        subIdStr,
      });
    }
  }

  if (paidComplete) {
    if (target === "family" && fid) {
      const [rFam] = await pool.query(
        `UPDATE families SET subscription_status = 'active', updated_at = NOW() WHERE id = ?`,
        [fid],
      );
      const rows = Number(rFam?.affectedRows ?? 0);
      logger.info("stripe.checkout_fallback_active", {
        target: "family",
        fid,
        userId,
        affectedRows: rows,
        paymentStatus: ps || null,
      });
      webhookVerbose({
        step: "checkout_fallback_active_family",
        affectedRows: rows,
        fid,
      });
    } else if (target === "user" && userId) {
      const [rUsr] = await pool.query(
        `UPDATE users SET subscription_status = 'active', updated_at = NOW() WHERE id = ?`,
        [userId],
      );
      const rows = Number(rUsr?.affectedRows ?? 0);
      logger.info("stripe.checkout_fallback_active", {
        target: "user",
        userId,
        affectedRows: rows,
        paymentStatus: ps || null,
      });
      webhookVerbose({
        step: "checkout_fallback_active_user",
        affectedRows: rows,
        userId,
      });
    }
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
    logger.info("stripe.checkout_link_summary", {
      outcome: "skipped_missing_user_or_customer",
      sessionId: session.id ?? null,
      mode: session.mode ?? null,
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

  /** /auth/me と同じ「請求・契約の対象 family_id」（default_family_id 優先の COALESCE ではズレることがある） */
  const famExpr = sqlUserFamilyIdExpr("u");
  const [[ur]] = await pool.query(
    `SELECT (${famExpr}) AS fid FROM users u WHERE u.id = ? LIMIT 1`,
    [userId],
  );
  const fid = ur?.fid != null ? Number(ur.fid) : null;

  webhookVerbose({
    step: "checkout_link_resolve",
    userId,
    fid: fid && Number.isFinite(fid) && fid > 0 ? fid : null,
    customerPrefix: customerId ? String(customerId).slice(0, 12) : null,
    subIdPrefix: subIdStr ? String(subIdStr).slice(0, 18) : null,
    sessionId: session.id ?? null,
  });

  if (fid && Number.isFinite(fid) && fid > 0) {
    const [famUpd] = await pool.query(
      `UPDATE families SET stripe_customer_id = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id), updated_at = NOW() WHERE id = ?`,
      [customerId, subIdStr, fid],
    );
    webhookVerbose({
      step: "checkout_families_set_customer",
      affectedRows: famUpd?.affectedRows ?? null,
      fid,
      userId,
    });

    await syncCheckoutSessionSubscription(pool, {
      fid,
      userId,
      subIdStr,
      session,
      target: "family",
    });
    logger.info("stripe.checkout_link_summary", {
      outcome: "family_row_updated",
      sessionId: session.id ?? null,
      userId,
      fid,
      familiesStripeColumnsRows: Number(famUpd?.affectedRows ?? 0),
      mode: session.mode ?? null,
      paymentStatus: session.payment_status ?? null,
    });
    return;
  }

  /** 家族未設定かつ users に Stripe 列が無い環境ではここは失敗する（通常は default_family あり） */
  try {
    const [usrUpd] = await pool.query(
      `UPDATE users SET stripe_customer_id = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id), updated_at = NOW() WHERE id = ?`,
      [customerId, subIdStr, userId],
    );
    webhookVerbose({
      step: "checkout_users_set_customer",
      affectedRows: usrUpd?.affectedRows ?? null,
      userId,
    });

    await syncCheckoutSessionSubscription(pool, {
      fid: null,
      userId,
      subIdStr,
      session,
      target: "user",
    });
    logger.info("stripe.checkout_link_summary", {
      outcome: "user_row_updated",
      sessionId: session.id ?? null,
      userId,
      usersStripeColumnsRows: Number(usrUpd?.affectedRows ?? 0),
      mode: session.mode ?? null,
      paymentStatus: session.payment_status ?? null,
    });
  } catch (e) {
    const errno = Number(e?.errno);
    if (errno === 1054) {
      logger.warn("stripe.checkout_users_columns_missing_or_no_family", {
        userId,
        detail:
          "所属家族が無いか、users から Stripe 列を削除済みです。families への紐付けを確認してください。",
      });
      logger.info("stripe.checkout_link_summary", {
        outcome: "skipped_schema_or_no_family",
        sessionId: session.id ?? null,
        userId,
      });
      return;
    }
    throw e;
  }
}
