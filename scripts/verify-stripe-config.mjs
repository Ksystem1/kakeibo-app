/**
 * GET /config が 200 で JSON（stripe に Price 関連）を返すか検証する。
 * 使用例:
 *   node scripts/verify-stripe-config.mjs
 *   VERIFY_API_URL=http://127.0.0.1:3456 node scripts/verify-stripe-config.mjs
 */
const base = String(process.env.VERIFY_API_URL ?? "http://127.0.0.1:3456").replace(
  /\/$/,
  "",
);

const paths = ["/config", "/api/config"];

async function tryUrl(path) {
  const url = `${base}${path}`;
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[verify-stripe-config] ${url} — 接続失敗: ${msg}`);
    return false;
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    console.error(`[verify-stripe-config] ${url} — 非 JSON: ${text.slice(0, 200)}`);
    return false;
  }
  console.log(`[verify-stripe-config] ${url} → ${res.status}`);
  console.log(JSON.stringify(json, null, 2));
  if (!res.ok) return false;
  const stripe = json.stripe ?? json;
  const hasPrice =
    stripe?.priceIdConfigured === true ||
    Boolean(String(stripe?.stripeTestPriceId ?? "").trim());
  const ready =
    stripe?.checkoutReady === true ||
    (hasPrice && stripe?.secretKeyConfigured === true);
  if (!hasPrice) {
    console.error("[verify-stripe-config] NG: Price ID 系の情報がありません");
    return false;
  }
  if (!ready) {
    console.warn(
      "[verify-stripe-config] WARN: checkoutReady が false（秘密鍵未設定の可能性）",
    );
  }
  return res.status === 200;
}

let ok = false;
for (const p of paths) {
  try {
    if (await tryUrl(p)) {
      ok = true;
      break;
    }
  } catch (e) {
    console.error(`[verify-stripe-config] ${base}${p}`, e?.message ?? e);
  }
}

if (!ok) {
  console.error(
    "[verify-stripe-config] 失敗: API を起動し、VERIFY_API_URL または既定 localhost:3456 を確認してください。",
  );
  process.exit(1);
}
console.log("[verify-stripe-config] OK");
process.exit(0);
