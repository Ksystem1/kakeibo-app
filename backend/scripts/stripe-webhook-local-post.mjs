#!/usr/bin/env node
/**
 * ローカル API に署名付き Stripe Webhook イベントを POST し、ハンドラと DB 更新ログを端末で確認する。
 *
 * 事前: cd backend && npm run dev:api（別ターミナル）
 * 環境: backend/.env に RDS_* と STRIPE_WEBHOOK_SECRET（本番 whsec で本番 DB に書き込むので注意）
 *
 * 必須:
 *   STRIPE_WEBHOOK_SELFTEST_USER_ID — DB に存在する users.id
 *   STRIPE_WEBHOOK_SECRET
 *
 * 任意:
 *   STRIPE_WEBHOOK_SELFTEST_EVENT — checkout.session.completed（既定）| customer.subscription.created
 *   STRIPE_WEBHOOK_SELFTEST_URL — 既定 http://127.0.0.1:3456/api/webhooks/stripe
 *   STRIPE_WEBHOOK_SELFTEST_CUSTOMER — 既定 cus_selftest_local
 *   STRIPE_WEBHOOK_SELFTEST_SUBSCRIPTION — subscription イベントでは必須に近い（未設定時は sub_selftest_<timestamp>）
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
const eventType = String(
  process.env.STRIPE_WEBHOOK_SELFTEST_EVENT ?? "checkout.session.completed",
).trim();

const url =
  String(process.env.STRIPE_WEBHOOK_SELFTEST_URL ?? "").trim() ||
  "http://127.0.0.1:3456/api/webhooks/stripe";

const now = Math.floor(Date.now() / 1000);
const periodEnd = now + 2_592_000;

/** @type {Record<string, unknown>} */
let dataObject;
/** @type {string} */
let type;

if (eventType === "customer.subscription.created" || eventType === "customer.subscription.updated") {
  type = eventType;
  const subId =
    String(process.env.STRIPE_WEBHOOK_SELFTEST_SUBSCRIPTION ?? "").trim() ||
    `sub_selftest_${Date.now()}`;
  dataObject = {
    id: subId,
    object: "subscription",
    customer,
    status: "active",
    metadata: { kakeibo_user_id: String(userId) },
    current_period_end: periodEnd,
    cancel_at_period_end: false,
    created: now,
  };
} else if (eventType === "checkout.session.completed") {
  type = "checkout.session.completed";
  const subRaw = String(process.env.STRIPE_WEBHOOK_SELFTEST_SUBSCRIPTION ?? "").trim();
  const subscription = subRaw === "" ? null : subRaw;
  const sessionObj = {
    id: `cs_selftest_${Date.now()}`,
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    customer,
    metadata: { kakeibo_user_id: String(userId) },
    client_reference_id: String(userId),
    amount_total: 1000,
    currency: "jpy",
    created: now,
  };
  if (subscription != null) {
    sessionObj.subscription = subscription;
  }
  dataObject = sessionObj;
} else {
  console.error(
    "[stripe-webhook-selftest] 未対応の STRIPE_WEBHOOK_SELFTEST_EVENT:",
    eventType,
    "（checkout.session.completed または customer.subscription.created|updated）",
  );
  process.exit(1);
}

const event = {
  id: `evt_selftest_${Date.now()}`,
  object: "event",
  api_version: "2024-06-20",
  created: now,
  livemode: String(process.env.STRIPE_WEBHOOK_SELFTEST_LIVEMODE ?? "").trim() === "1",
  pending_webhooks: 1,
  type,
  data: {
    object: dataObject,
  },
};

const payload = JSON.stringify(event);
const stripeSignature = Stripe.webhooks.generateTestHeaderString({
  payload,
  secret,
});

console.error("[stripe-webhook-selftest] event type:", type);
console.error("[stripe-webhook-selftest] POST", url);

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
