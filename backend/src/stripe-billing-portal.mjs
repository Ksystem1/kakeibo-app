/**
 * Stripe Customer Billing Portal（プラン管理・解約はポータルで行う）
 */
import Stripe from "stripe";
import { sqlUserFamilyIdExpr } from "./family-billing-scope.mjs";
import { assertAllowedRedirectUrl, parseAllowedOrigins } from "./stripe-checkout.mjs";
import { requireStripeSecretKey } from "./stripe-config.mjs";

const FAM_JOIN_U = sqlUserFamilyIdExpr("u");

function isNoSuchCustomerError(e) {
  const code = String(e?.code || "");
  const msg = String(e?.message || "");
  return code === "resource_missing" && msg.includes("No such customer");
}

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
    `SELECT u.id, f.id AS family_id, f.stripe_customer_id AS stripe_customer_id
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
  let session;
  try {
    session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
  } catch (e) {
    if (!isNoSuchCustomerError(e)) throw e;
    if (Number.isFinite(Number(user.family_id)) && Number(user.family_id) > 0) {
      await pool.query(
        `UPDATE families
         SET stripe_customer_id = NULL, stripe_subscription_id = NULL, updated_at = NOW()
         WHERE id = ?`,
        [Number(user.family_id)],
      );
    }
    throw new Error(
      "Stripe 顧客情報を再同期しました。お手数ですが、もう一度「契約する（Stripe Checkout）」からお進みください。",
    );
  }
  const url = session.url;
  if (!url) {
    throw new Error("Stripe がポータル URL を返しませんでした");
  }
  return url;
}
