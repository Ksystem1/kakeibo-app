/**
 * 本番でよくある誤設定（フロント URL に Webhook）を検出する。
 *
 * - GET API オリジン / … JSON（kakeibo-api）
 * - POST フロント/kakeibo/api/stripe/webhook … HTML（SPA）なら「誤ルート」検知
 * - POST API/api/stripe/webhook … JSON（MissingStripeSignature 等）なら API に届いている
 *
 * 使用例:
 *   node scripts/verify-stripe-webhook-routing.mjs
 *   VERIFY_API_ORIGIN=https://api.ksystemapp.com VERIFY_FRONTEND_ORIGIN=https://ksystemapp.com node scripts/verify-stripe-webhook-routing.mjs
 */
const apiBase = String(process.env.VERIFY_API_ORIGIN ?? "https://api.ksystemapp.com").replace(
  /\/$/,
  "",
);
const frontBase = String(
  process.env.VERIFY_FRONTEND_ORIGIN ?? "https://ksystemapp.com",
).replace(/\/$/, "");
const appPath = String(process.env.VERIFY_APP_PATH_PREFIX ?? "kakeibo").replace(/^\/+|\/+$/g, "");

const badWebhookUrl = `${frontBase}/${appPath}/api/stripe/webhook`;
const goodWebhookUrl = `${apiBase}/api/stripe/webhook`;

function looksLikeHtml(text) {
  const t = text.trimStart().slice(0, 80).toLowerCase();
  return t.startsWith("<!doctype") || t.startsWith("<html");
}

async function main() {
  console.log("[verify-stripe-webhook-routing] API base:", apiBase);
  console.log("[verify-stripe-webhook-routing] frontend misroute probe:", badWebhookUrl);
  console.log("[verify-stripe-webhook-routing] API webhook probe:", goodWebhookUrl);

  let res = await fetch(`${apiBase}/`, { headers: { accept: "application/json" } });
  const rootText = await res.text();
  let rootJson;
  try {
    rootJson = JSON.parse(rootText);
  } catch {
    console.error(
      "[verify-stripe-webhook-routing] NG: GET",
      `${apiBase}/`,
      "が JSON ではありません:",
      rootText.slice(0, 200),
    );
    process.exit(1);
  }
  if (rootJson.service !== "kakeibo-api") {
    console.error("[verify-stripe-webhook-routing] NG: service が kakeibo-api ではありません");
    process.exit(1);
  }
  if (!rootJson.stripeWebhookRouting?.recommendedWebhookUrls?.length) {
    console.warn(
      "[verify-stripe-webhook-routing] WARN: GET / に stripeWebhookRouting.recommendedWebhookUrls がありません（古いデプロイの可能性）",
    );
  }
  console.log("[verify-stripe-webhook-routing] GET / OK (kakeibo-api)");

  res = await fetch(badWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const badText = await res.text();
  if (!looksLikeHtml(badText)) {
    console.warn(
      "[verify-stripe-webhook-routing] WARN: フロント URL への POST が HTML ではありません。",
      "CloudFront の振り分け変更済みか、URL が異なる可能性があります。本文先頭:",
      badText.slice(0, 120),
    );
  } else {
    console.log(
      "[verify-stripe-webhook-routing] フロント URL は HTML を返します（Stripe をここに向けると同期されません）— 期待どおりの警告パターンです。",
    );
  }

  res = await fetch(goodWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const goodText = await res.text();
  let goodJson;
  try {
    goodJson = JSON.parse(goodText);
  } catch {
    console.error(
      "[verify-stripe-webhook-routing] NG: API の Webhook が JSON を返しません（HTML やプロキシ誤りの可能性）:",
      goodText.slice(0, 300),
    );
    process.exit(1);
  }
  const err = goodJson.error;
  if (
    err !== "MissingStripeSignature" &&
    err !== "InvalidSignature" &&
    err !== "StripeWebhookNotConfigured"
  ) {
    console.warn(
      "[verify-stripe-webhook-routing] WARN: 想定外の error フィールド:",
      err,
      "（署名なし POST のため MissingStripeSignature が一般的）",
    );
  }
  if (looksLikeHtml(goodText)) {
    console.error("[verify-stripe-webhook-routing] NG: API Webhook が HTML を返しています");
    process.exit(1);
  }
  console.log("[verify-stripe-webhook-routing] API Webhook は JSON を返します — OK");
  console.log("[verify-stripe-webhook-routing] Stripe ダッシュボードの URL は次を推奨:", goodWebhookUrl);
  process.exit(0);
}

main().catch((e) => {
  console.error("[verify-stripe-webhook-routing]", e);
  process.exit(1);
});
