/**
 * フロントエンドと同様の条件で GET /config を fetch（キャッシュ無効）。
 * 既定: Vite プロキシ先と同じ http://127.0.0.1:3456/api/config
 *
 *   npm run verify:frontend-api
 *   VERIFY_API_BASE=http://127.0.0.1:3456/api node scripts/verify-frontend-api-fetch.mjs
 */
const base = String(process.env.VERIFY_API_BASE ?? "http://127.0.0.1:3456/api").replace(
  /\/$/,
  "",
);
const url = `${base}/config?_cb=${Date.now()}`;

console.log("[verify-frontend-api] フロント視点: 解決 URL（プロキシ経由ならブラウザは /api/config）");
console.log("[verify-frontend-api] このスクリプトは直接叩く:", url);

const res = await fetch(url, {
  cache: "no-store",
  headers: {
    accept: "application/json",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  },
});
const text = await res.text();
console.log("[verify-frontend-api] status:", res.status);
let json;
try {
  json = text ? JSON.parse(text) : {};
} catch {
  console.error("[verify-frontend-api] 非 JSON:", text.slice(0, 400));
  process.exit(1);
}
console.log("[verify-frontend-api] body:", JSON.stringify(json, null, 2));
const stripe = json.stripe ?? json;
const priceOk =
  stripe?.priceIdConfigured === true ||
  Boolean(String(stripe?.stripeTestPriceId ?? "").trim());
const ready =
  stripe?.checkoutReady === true || (priceOk && stripe?.secretKeyConfigured === true);
if (!res.ok) {
  console.error("[verify-frontend-api] NG: HTTP 失敗");
  process.exit(1);
}
if (!priceOk) {
  console.error("[verify-frontend-api] NG: Price ID 情報なし");
  process.exit(1);
}
console.log("[verify-frontend-api] OK: 疎通成功。checkoutReady=", stripe?.checkoutReady, "priceOk=", priceOk);
if (!ready) {
  console.warn("[verify-frontend-api] WARN: checkoutReady が false（秘密鍵が API で未検出の可能性）");
}
process.exit(0);
