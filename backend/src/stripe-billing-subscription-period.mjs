/**
 * DB の subscription_period_end_at が空でも、Stripe 上のサブスク current_period_end を使って
 * 請求期間終了日（ISO 8601 文字列）を返す。設定画面の「有効期限」表示用。
 */
import Stripe from "stripe";
import { sqlUserFamilyIdExpr } from "./family-billing-scope.mjs";
import { requireStripeSecretKey } from "./stripe-config.mjs";

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

  let subId = r.sub != null ? String(r.sub).trim() : "";
  if (!subId.startsWith("sub_")) {
    const list = await stripe.subscriptions.list({
      customer: cus,
      status: "all",
      limit: 20,
    });
    const byPref = (s) => {
      const st = String(s?.status || "").toLowerCase();
      if (st === "active" || st === "trialing" || st === "past_due") return 0;
      if (s?.cancel_at_period_end) return 1;
      return 2;
    };
    const sorted = [...(list.data || [])].sort(
      (a, b) => byPref(a) - byPref(b) || 0,
    );
    const usable = sorted.find((s) => {
      const st = String(s?.status || "").toLowerCase();
      if (st === "active" || st === "trialing" || st === "past_due") return true;
      return Boolean(s?.cancel_at_period_end);
    });
    if (!usable) return null;
    subId = String(usable.id);
  }

  const sub = await stripe.subscriptions.retrieve(subId);
  const pe = Number(sub.current_period_end ?? 0);
  if (!pe || !Number.isFinite(pe) || pe <= 0) return null;
  return new Date(pe * 1000).toISOString();
}
