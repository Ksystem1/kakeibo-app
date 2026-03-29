/**
 * CORS_ORIGIN:
 * - 未設定 / "*" → 全オリジン許可
 * - カンマ区切り → ブラウザの Origin がリストに含まれるときだけその Origin を返す。
 *   一致しない場合は "*" にフォールバック（開発・複数フロント向けの緩めの挙動）
 */

function normalizeHeaders(raw) {
  const out = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v);
  }
  return out;
}

export function buildCorsHeaders(reqHeaders) {
  const raw = (process.env.CORS_ORIGIN ?? "*").trim();
  const h = normalizeHeaders(reqHeaders);
  const reqOrigin = h.origin || "";

  let allowOrigin = "*";
  if (raw && raw !== "*") {
    const list = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((x) => x !== "*");
    if (list.length > 0) {
      allowOrigin =
        reqOrigin && list.includes(reqOrigin) ? reqOrigin : "*";
    }
  }

  const headers = {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-headers":
      "content-type,authorization,x-user-id",
    "access-control-allow-methods":
      "OPTIONS,GET,POST,PUT,PATCH,DELETE",
  };
  if (allowOrigin !== "*") {
    headers.vary = "Origin";
  }
  return headers;
}

/** Express の cors ミドルウェア用 */
export function expressCorsOptions() {
  const raw = (process.env.CORS_ORIGIN ?? "*").trim();
  if (!raw || raw === "*") {
    return { origin: "*" };
  }
  const origins = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.includes("*")) {
    return { origin: "*" };
  }
  if (origins.length === 1) {
    return { origin: origins[0] };
  }
  return { origin: origins };
}
