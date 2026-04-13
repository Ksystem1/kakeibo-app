/**
 * Stripe Checkout Session（サブスク課金・Test mode 想定）
 */
import Stripe from "stripe";
import { sqlUserFamilyIdExpr } from "./family-billing-scope.mjs";
import {
  getStripeSecretKey,
  getStripeWebhookSecret,
  requireStripeSecretKey,
} from "./stripe-config.mjs";

const FAM_JOIN_U = sqlUserFamilyIdExpr("u");

const DEFAULT_ALLOWED_ORIGINS =
  "http://localhost:5173,http://127.0.0.1:5173,https://ksystemapp.com";

export function parseAllowedOrigins() {
  const raw = String(
    process.env.STRIPE_CHECKOUT_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS,
  ).trim();
  const out = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    try {
      const u = new URL(entry.includes("://") ? entry : `https://${entry}`);
      out.push(u.origin);
    } catch {
      /* skip */
    }
  }
  return out;
}

export function assertAllowedRedirectUrl(urlStr, allowedOrigins) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error("successUrl / cancelUrl が URL として不正です");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("successUrl / cancelUrl は http(s) のみです");
  }
  if (!allowedOrigins.includes(u.origin)) {
    throw new Error(
      `リダイレクト先の Origin が許可リストにありません: ${u.origin}（STRIPE_CHECKOUT_ALLOWED_ORIGINS を確認）`,
    );
  }
}

/** Checkout 用 Price ID（STRIPE_TEST_PRICE_ID を STRIPE_PRICE_ID より優先） */
export function getSubscriptionPriceId() {
  const testPrice = String(process.env.STRIPE_TEST_PRICE_ID ?? "").trim();
  const livePrice = String(process.env.STRIPE_PRICE_ID ?? "").trim();
  return testPrice || livePrice;
}

/** Price ID と秘密鍵が揃っているか（フロント向けステータス用。秘密は返さない） */
export function isStripeCheckoutConfigured() {
  if (!getSubscriptionPriceId()) return false;
  return Boolean(getStripeSecretKey());
}

/** GET /config 用。秘密鍵は含めない。stripeTestPriceId は検証用（本番では ECS の env で確認後に返却をやめることも可） */
export function getStripeCheckoutPublicConfig() {
  const testRaw = String(process.env.STRIPE_TEST_PRICE_ID ?? "").trim();
  return {
    checkoutReady: isStripeCheckoutConfigured(),
    priceIdConfigured: Boolean(getSubscriptionPriceId()),
    secretKeyConfigured: Boolean(getStripeSecretKey()),
    webhookConfigured: Boolean(getStripeWebhookSecret()),
    /** process.env の STRIPE_TEST_PRICE_ID をそのまま返す（未設定は空文字） */
    stripeTestPriceId: testRaw,
  };
}

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 * @param {Record<string, unknown>} body
 * @returns {Promise<string>} Checkout URL
 */
export async function createBillingCheckoutSession(pool, userId, body) {
  const priceId = getSubscriptionPriceId();
  if (!priceId) {
    throw new Error(
      "STRIPE_TEST_PRICE_ID または STRIPE_PRICE_ID を設定してください",
    );
  }

  const key = requireStripeSecretKey();
  const requireTest =
    String(process.env.STRIPE_CHECKOUT_REQUIRE_TEST_KEY ?? "").trim() === "1";
  if (requireTest && !key.startsWith("sk_test_")) {
    throw new Error(
      "STRIPE_CHECKOUT_REQUIRE_TEST_KEY=1 のため、テスト秘密鍵（sk_test_）のみ利用できます",
    );
  }

  const allowedOrigins = parseAllowedOrigins();
  const successUrl = String(body?.successUrl ?? "").trim();
  const cancelUrl = String(body?.cancelUrl ?? "").trim();
  if (!successUrl || !cancelUrl) {
    throw new Error("successUrl と cancelUrl が必要です");
  }
  assertAllowedRedirectUrl(successUrl, allowedOrigins);
  assertAllowedRedirectUrl(cancelUrl, allowedOrigins);

  const [[user]] = await pool.query(
    `SELECT u.id, u.email, f.stripe_customer_id AS stripe_customer_id
     FROM users u
     LEFT JOIN families f ON f.id = ${FAM_JOIN_U}
     WHERE u.id = ? LIMIT 1`,
    [userId],
  );
  if (!user) {
    throw new Error("ユーザーが見つかりません");
  }

  const stripe = new Stripe(key);

  /** @type {import("stripe").Stripe.Checkout.SessionCreateParams} */
  const params = {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: String(userId),
    metadata: { kakeibo_user_id: String(userId) },
  };

  const email = user.email != null ? String(user.email).trim() : "";
  const existingCus =
    user.stripe_customer_id != null
      ? String(user.stripe_customer_id).trim()
      : "";
  if (existingCus.startsWith("cus_")) {
    params.customer = existingCus;
  } else if (email) {
    params.customer_email = email;
  }

  const session = await stripe.checkout.sessions.create(params);
  const url = session.url;
  if (!url) {
    throw new Error("Stripe が Checkout URL を返しませんでした");
  }
  return url;
}
