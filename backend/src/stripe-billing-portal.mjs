/**
 * Stripe Customer Billing Portal（プラン管理・解約はポータルで行う）
 */
import Stripe from "stripe";
import { sqlUserFamilyIdExpr } from "./family-billing-scope.mjs";
import { assertAllowedRedirectUrl, parseAllowedOrigins } from "./stripe-checkout.mjs";
import { requireStripeSecretKey } from "./stripe-config.mjs";

const FAM_JOIN_U = sqlUserFamilyIdExpr("u");

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 * @param {Record<string, unknown>} body
 * @returns {Promise<string>} Portal URL
 */
export async function createBillingPortalSession(pool, userId, body) {
  const returnUrl = String(body?.returnUrl ?? "").trim();
  if (!returnUrl) {
    throw new Error("returnUrl が必要です");
  }
  const allowedOrigins = parseAllowedOrigins();
  assertAllowedRedirectUrl(returnUrl, allowedOrigins);

  const [[user]] = await pool.query(
    `SELECT u.id, f.stripe_customer_id AS stripe_customer_id
     FROM users u
     LEFT JOIN families f ON f.id = ${FAM_JOIN_U}
     WHERE u.id = ? LIMIT 1`,
    [userId],
  );
  if (!user) {
    throw new Error("ユーザーが見つかりません");
  }
  const customerId =
    user.stripe_customer_id != null ? String(user.stripe_customer_id).trim() : "";
  if (!customerId.startsWith("cus_")) {
    throw new Error(
      "Stripe 顧客が未登録です。先にプレミアム契約（Checkout）を完了してください",
    );
  }

  const stripe = new Stripe(requireStripeSecretKey());
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  const url = session.url;
  if (!url) {
    throw new Error("Stripe がポータル URL を返しませんでした");
  }
  return url;
}
