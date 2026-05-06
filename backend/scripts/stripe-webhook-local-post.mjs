#!/usr/bin/env node
/**
 * ローカル API に署名付き `checkout.session.completed` を POST し、Webhook ハンドラと DB 更新ログを端末で確認する。
 *
 * 事前: cd backend && npm run dev:api（別ターミナル）
 * 環境: backend/.env に RDS_* と STRIPE_WEBHOOK_SECRET（本番の whsec を使う場合は本番 DB 更新に注意）
 *
 * 必須:
 *   STRIPE_WEBHOOK_SELFTEST_USER_ID — DB に存在する users.id（metadata.kakeibo_user_id に入る）
 *   STRIPE_WEBHOOK_SECRET — 検証に使う whsec（Stripe CLI `stripe listen` の表示値でも可）
 *
 * 任意:
 *   STRIPE_WEBHOOK_SELFTEST_URL — 既定 http://127.0.0.1:3456/api/webhooks/stripe
 *   STRIPE_WEBHOOK_SELFTEST_CUSTOMER — 既定 cus_selftest_local（DB には families.stripe_customer_id として保存されるだけ）
 *   STRIPE_WEBHOOK_SELFTEST_SUBSCRIPTION — 空なら Subscription retrieve をスキップし paid フォールバックのみ（ローカル検証向き）
 */
import "dotenv/config";
import "../src/load-env.mjs";
import Stripe from "stripe";

const secret = String(process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
if (!secret) {
  console.error("[stripe-webhook-selftest] STRIPE_WEBHOOK_SECRET が未設定です。");
  process.exit(1);
}

const userId = Number(String(process.env.STRIPE_WEBHOOK_SELFTEST_USER_ID ?? "").trim());
if (!Number.isFinite(userId) || userId <= 0) {
  console.error(
    "[stripe-webhook-selftest] STRIPE_WEBHOOK_SELFTEST_USER_ID に users.id（正の整数）を設定してください。",
  );
  process.exit(1);
}

const customer =
  String(process.env.STRIPE_WEBHOOK_SELFTEST_CUSTOMER ?? "cus_selftest_local").trim() || "cus_selftest_local";
const subRaw = String(process.env.STRIPE_WEBHOOK_SELFTEST_SUBSCRIPTION ?? "").trim();
const subscription = subRaw === "" ? null : subRaw;

const url =
  String(process.env.STRIPE_WEBHOOK_SELFTEST_URL ?? "").trim() ||
  "http://127.0.0.1:3456/api/webhooks/stripe";

const sessionObj = {
  id: `cs_selftest_${Date.now()}`,
  object: "checkout.session",
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  customer,
  metadata: { kakeibo_user_id: String(userId) },
  client_reference_id: null,
  amount_total: 1000,
  currency: "jpy",
  created: Math.floor(Date.now() / 1000),
};
if (subscription != null) {
  sessionObj.subscription = subscription;
}

const event = {
  id: `evt_selftest_${Date.now()}`,
  object: "event",
  api_version: "2024-06-20",
  created: Math.floor(Date.now() / 1000),
  livemode: String(process.env.STRIPE_WEBHOOK_SELFTEST_LIVEMODE ?? "").trim() === "1",
  pending_webhooks: 1,
  type: "checkout.session.completed",
  data: {
    object: sessionObj,
  },
};

const payload = JSON.stringify(event);
const stripeSignature = Stripe.webhooks.generateTestHeaderString({
  payload,
  secret,
});

console.error("[stripe-webhook-selftest] POST", url);
console.error("[stripe-webhook-selftest] body preview", payload.slice(0, 220), "…");

const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "stripe-signature": stripeSignature,
  },
  body: payload,
});

const text = await res.text();
console.error("[stripe-webhook-selftest] HTTP", res.status, text.slice(0, 800));
process.exit(res.ok ? 0 : 1);
