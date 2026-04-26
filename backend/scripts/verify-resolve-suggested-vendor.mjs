/**
 * 本番（または Staging）で POST /receipts/resolve-suggested-vendor の疎通と Bedrock を確認する。
 *
 * 使い方:
 *   cd backend
 *   set API_BASE_URL=https://api.ksystemapp.com   （末尾スラッシュなし）
 *   set API_JWT=...                               （必須: ログイン後の JWT）
 *   set VENDOR_NAME=ローソン
 *   npm run verify:receipt:vendor
 *
 * 失敗時は IAM / モデル承認 / スロットリングのメッセージを確認。HTTP 200 + found:false は権限等で名寄せできなかった場合にあり得ます。
 */
const API = String(process.env.API_BASE_URL || "https://api.ksystemapp.com").replace(/\/$/, "");
const JWT = String(process.env.API_JWT || process.env.JWT || "").trim();
const VENDOR = String(process.env.VENDOR_NAME || "てすと店 レシート").trim();

async function main() {
  if (!JWT) {
    console.error("環境変数 API_JWT（Bearer 用）を設定してください。");
    process.exit(1);
  }
  if (VENDOR.length < 2) {
    console.error("VENDOR_NAME は2文字以上にしてください。");
    process.exit(1);
  }
  const t0 = Date.now();
  const res = await fetch(`${API}/receipts/resolve-suggested-vendor`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${JWT}`,
    },
    body: JSON.stringify({ vendorName: VENDOR }),
  });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    console.error("Non-JSON response:", res.status, text.slice(0, 500));
    process.exit(1);
  }
  const ms = Date.now() - t0;
  console.log(JSON.stringify({ httpStatus: res.status, clientDurationMs: ms, body: j }, null, 2));
  if (!res.ok) {
    process.exit(1);
  }
  if (j.vendorResolveSkipped && j.userHint) {
    console.warn("[warn] vendorResolveSkipped: Bedrock/保存をスキップ。userHint:" + j.userHint);
  }
  if (j.found && j.suggestedVendor?.suggestedStoreName) {
    console.log("[ok] 名寄せ結果:", j.suggestedVendor.suggestedStoreName, "inference:", j.suggestedVendor.inferenceConfidence);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
