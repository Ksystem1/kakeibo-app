/**
 * DB の subscription_period_end_at が空でも、Stripe 上のサブスクの終了／解約予定日を ISO 8601 で返す。
 * 設定画面の「有効期限・解約予定日」表示用。
 */
import Stripe from "stripe";
import { sqlUserFamilyIdExpr } from "./family-billing-scope.mjs";
import { requireStripeSecretKey } from "./stripe-config.mjs";
import { pickBestStripeSubscriptionForCustomer } from "./stripe-subscription-reconcile-core.mjs";
import { effectiveSubscriptionPeriodEndUnixFromStripe } from "./subscription-logic.mjs";

const FAM_JOIN_U = sqlUserFamilyIdExpr("u");

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 * @returns {Promise<string | null>} ISO 8601、または取れなければ null
 */
export async function fetchSubscriptionPeriodEndIsoFromStripeLive(pool, userId) {
  let stripe;
  try {
    stripe = new Stripe(requireStripeSecretKey());
  } catch {
    return null;
  }

  const [rows] = await pool.query(
    `SELECT f.stripe_customer_id AS cus, f.stripe_subscription_id AS sub
     FROM users u
     LEFT JOIN families f ON f.id = ${FAM_JOIN_U}
     WHERE u.id = ? LIMIT 1`,
    [userId],
  );
  const r = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!r) return null;
  const cus = r.cus != null ? String(r.cus).trim() : "";
  if (!cus.startsWith("cus_")) return null;

  let sub = null;
  const subIdStored = r.sub != null ? String(r.sub).trim() : "";
  if (subIdStored.startsWith("sub_")) {
    try {
      sub = await stripe.subscriptions.retrieve(subIdStored);
    } catch {
      sub = null;
    }
  }

  if (!sub) {
    const list = await stripe.subscriptions.list({
      customer: cus,
      status: "all",
      limit: 30,
    });
    sub = pickBestStripeSubscriptionForCustomer(list.data || []);
  }

  if (!sub) return null;
  const pe = effectiveSubscriptionPeriodEndUnixFromStripe(sub);
  if (!pe || !Number.isFinite(pe) || pe <= 0) return null;
  return new Date(pe * 1000).toISOString();
}
