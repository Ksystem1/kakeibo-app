/**
 * リバースプロキシで /api 等のプレフィックスが付くとき用（環境変数 API_PATH_PREFIX）
 */
export function stripApiPathPrefix(rawPath) {
  let p = rawPath.split("?")[0] || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  const prefix = (process.env.API_PATH_PREFIX || "").trim().replace(/\/$/, "");
  if (!prefix) return p;
  if (p === prefix || p.startsWith(`${prefix}/`)) {
    const rest = p === prefix ? "/" : p.slice(prefix.length);
    return rest.startsWith("/") ? rest : `/${rest}`;
  }
  return p;
}
