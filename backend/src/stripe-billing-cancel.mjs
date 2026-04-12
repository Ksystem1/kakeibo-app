/**
 * サブスクを「請求期間終了時に解約」（Stripe cancel_at_period_end）
 */
import Stripe from "stripe";
import { requireStripeSecretKey } from "./stripe-config.mjs";

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 */
export async function cancelUserSubscriptionAtPeriodEnd(pool, userId) {
  let rows;
  try {
    [rows] = await pool.query(
      `SELECT id, stripe_customer_id, stripe_subscription_id FROM users WHERE id = ? LIMIT 1`,
      [userId],
    );
  } catch {
    [rows] = await pool.query(
      `SELECT id, stripe_customer_id FROM users WHERE id = ? LIMIT 1`,
      [userId],
    );
  }
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
