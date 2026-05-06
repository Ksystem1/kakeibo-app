/**
 * リバースプロキシで /api 等のプレフィックスが付くとき用（環境変数 API_PATH_PREFIX）
 * その後、同一オリジンで `https://…/kakeibo/...` のように届くパスを正規化（Stripe Webhook 用 URL 等）
 */
export function stripApiPathPrefix(rawPath) {
  let p = rawPath.split("?")[0] || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  const prefix = (process.env.API_PATH_PREFIX || "").trim().replace(/\/$/, "");
  if (prefix) {
    if (p === prefix || p.startsWith(`${prefix}/`)) {
      const rest = p === prefix ? "/" : p.slice(prefix.length);
      p = rest.startsWith("/") ? rest : `/${rest}`;
    }
  }
  if (p === "/kakeibo" || p.startsWith("/kakeibo/")) {
    const rest = p === "/kakeibo" ? "/" : p.slice("/kakeibo".length);
    p = rest.startsWith("/") ? rest : `/${rest}`;
  }
  return p;
}
