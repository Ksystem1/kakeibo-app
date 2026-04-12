/**
 * サブスクを「請求期間終了時に解約」（Stripe cancel_at_period_end）
 */
import Stripe from "stripe";
import { sqlUserFamilyIdExpr } from "./family-billing-scope.mjs";
import { requireStripeSecretKey } from "./stripe-config.mjs";

const FAM_JOIN_U = sqlUserFamilyIdExpr("u");

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 */
export async function cancelUserSubscriptionAtPeriodEnd(pool, userId) {
  const [rows] = await pool.query(
    `SELECT u.id,
      f.stripe_customer_id AS stripe_customer_id,
      f.stripe_subscription_id AS stripe_subscription_id
     FROM users u
     LEFT JOIN families f ON f.id = ${FAM_JOIN_U}
     WHERE u.id = ? LIMIT 1`,
    [userId],
  );
  const user = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!user) {
    throw new Error("ユーザーが見つかりません");
  }
  const customerId =
    user.stripe_customer_id != null ? String(user.stripe_customer_id).trim() : "";
  if (!customerId.startsWith("cus_")) {
    throw new Error("Stripe 顧客が未登録です。先に Checkout で契約してください。");
  }

  const stripe = new Stripe(requireStripeSecretKey());
  let subId =
    user.stripe_subscription_id != null
      ? String(user.stripe_subscription_id).trim()
      : "";
  if (!subId.startsWith("sub_")) {
    const list = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 10,
    });
    const usable = list.data.find(
      (s) => s.status === "active" || s.status === "trialing" || s.status === "past_due",
    );
    if (!usable) {
      throw new Error("解約対象の有効なサブスクリプションがありません");
    }
    subId = usable.id;
  }

  await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
  return { ok: true, subscriptionId: subId };
}
