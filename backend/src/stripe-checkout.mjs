/**
 * Stripe Checkout Session（サブスク課金）
 * Price ID は getSubscriptionPriceId() が秘密鍵（sk_live_ / sk_test_）に合わせて選ぶ。
 */
import Stripe from "stripe";
import { sqlUserFamilyIdExpr } from "./family-billing-scope.mjs";
import {
  getStripeSecretKey,
  getStripeWebhookSecret,
  requireStripeSecretKey,
} from "./stripe-config.mjs";

const FAM_JOIN_U = sqlUserFamilyIdExpr("u");

const DEFAULT_ALLOWED_ORIGINS = "http://127.0.0.1:5173,https://ksystemapp.com";

function isNoSuchCustomerError(e) {
  const code = String(e?.code || "");
  const msg = String(e?.message || "");
  return code === "resource_missing" && msg.includes("No such customer");
}

async function clearFamilyStripeLinkIfAny(pool, familyId) {
  if (!Number.isFinite(Number(familyId)) || Number(familyId) <= 0) return;
  await pool.query(
    `UPDATE families
     SET stripe_customer_id = NULL, stripe_subscription_id = NULL, updated_at = NOW()
     WHERE id = ?`,
    [Number(familyId)],
  );
}

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

/**
 * Checkout 用サブスク Price ID。
 * Stripe 秘密鍵のモードと一致する ID を優先し、Live 鍵で誤って Test の price_ だけが選ばれることを防ぐ。
 *
 * - sk_live_: STRIPE_PRICE_ID を優先、無ければ STRIPE_TEST_PRICE_ID（ECS の従来1本注入用）
 * - sk_test_: STRIPE_TEST_PRICE_ID を優先、無ければ STRIPE_PRICE_ID
 * - 鍵が未設定・不明形式: 後方互換のため testVar || liveVar
 */
export function getSubscriptionPriceId() {
  const testPrice = String(process.env.STRIPE_TEST_PRICE_ID ?? "").trim();
  const livePrice = String(process.env.STRIPE_PRICE_ID ?? "").trim();
  const key = String(getStripeSecretKey() ?? "").trim();
  if (key.startsWith("sk_live_")) {
    return livePrice || testPrice;
  }
  if (key.startsWith("sk_test_")) {
    return testPrice || livePrice;
  }
  return testPrice || livePrice;
}

/** Price ID と秘密鍵が揃っているか（フロント向けステータス用。秘密は返さない） */
export function isStripeCheckoutConfigured() {
  if (!getSubscriptionPriceId()) return false;
  return Boolean(getStripeSecretKey());
}

/** 秘密鍵本体は返さない。GET /config で本番がテスト鍵かどうかの確認用 */
export function getStripeSecretKeyMode() {
  const k = String(getStripeSecretKey() ?? "").trim();
  if (k.startsWith("sk_live_")) return "live";
  if (k.startsWith("sk_test_")) return "test";
  return "unknown";
}

/** GET /config 用。秘密鍵は含めない。stripeTestPriceId は検証用（本番では ECS の env で確認後に返却をやめることも可） */
export function getStripeCheckoutPublicConfig() {
  const testRaw = String(process.env.STRIPE_TEST_PRICE_ID ?? "").trim();
  return {
    checkoutReady: isStripeCheckoutConfigured(),
    priceIdConfigured: Boolean(getSubscriptionPriceId()),
    secretKeyConfigured: Boolean(getStripeSecretKey()),
    webhookConfigured: Boolean(getStripeWebhookSecret()),
    /** sk_live_ / sk_test_ / unknown（キー文字列は返さない） */
    secretKeyMode: getStripeSecretKeyMode(),
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
  const key = requireStripeSecretKey();
  const keyMode = key.startsWith("sk_live_")
    ? "live"
    : key.startsWith("sk_test_")
      ? "test"
      : "unknown";
  const debugLogOn = String(process.env.STRIPE_CHECKOUT_DEBUG_LOG ?? "").trim() === "1";
  if (debugLogOn) {
    const maskedPrice =
      priceId && priceId.length > 8
        ? `${priceId.slice(0, 8)}...${priceId.slice(-4)}`
        : priceId || "";
    console.log("[stripe-checkout] create session requested", {
      userId: Number(userId),
      keyMode,
      hasPriceId: Boolean(priceId),
      priceId: maskedPrice,
    });
  }
  if (!priceId) {
    throw new Error(
      "STRIPE_TEST_PRICE_ID または STRIPE_PRICE_ID を設定してください",
    );
  }

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
  if (debugLogOn) {
    try {
      const successOrigin = successUrl ? new URL(successUrl).origin : "";
      const cancelOrigin = cancelUrl ? new URL(cancelUrl).origin : "";
      console.log("[stripe-checkout] redirect origins", {
        keyMode,
        successOrigin,
        cancelOrigin,
        allowedOrigins,
      });
    } catch {
      // URL バリデーションは後続の assertAllowedRedirectUrl でエラー化する
    }
  }
  if (!successUrl || !cancelUrl) {
    throw new Error("successUrl と cancelUrl が必要です");
  }
  assertAllowedRedirectUrl(successUrl, allowedOrigins);
  assertAllowedRedirectUrl(cancelUrl, allowedOrigins);

  const [[user]] = await pool.query(
    `SELECT u.id, u.email, f.id AS family_id, f.stripe_customer_id AS stripe_customer_id
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
    subscription_data: {
      metadata: { kakeibo_user_id: String(userId) },
    },
  };

  const email = user.email != null ? String(user.email).trim() : "";
  const existingCus =
    user.stripe_customer_id != null
      ? String(user.stripe_customer_id).trim()
      : "";
  if (existingCus.startsWith("cus_")) {
    try {
      const list = await stripe.subscriptions.list({
        customer: existingCus,
        status: "all",
        limit: 20,
      });
      const activeLike = list.data.find((s) =>
        ["active", "trialing", "past_due", "unpaid"].includes(String(s.status || "")),
      );
      if (activeLike) {
        throw new Error(
          "既に有効なサブスクリプションがあります。新規契約ではなく「解約（プラン管理）」を利用してください",
        );
      }
      params.customer = existingCus;
    } catch (e) {
      if (!isNoSuchCustomerError(e)) throw e;
      // 別 Stripe 環境で作られた古い cus_ が残っている場合は DB を掃除して再作成へ進める
      await clearFamilyStripeLinkIfAny(pool, user.family_id);
      if (email) params.customer_email = email;
    }
  } else if (email) {
    params.customer_email = email;
  }

  let session;
  try {
    session = await stripe.checkout.sessions.create(params);
  } catch (e) {
    if (!isNoSuchCustomerError(e)) throw e;
    await clearFamilyStripeLinkIfAny(pool, user.family_id);
    const retryParams = { ...params };
    delete retryParams.customer;
    if (email) retryParams.customer_email = email;
    session = await stripe.checkout.sessions.create(retryParams);
  }
  const url = session.url;
  if (!url) {
    throw new Error("Stripe が Checkout URL を返しませんでした");
  }
  return url;
}
