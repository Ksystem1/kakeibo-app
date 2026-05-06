/**
 * Stripe Webhook URL 案内用: このリクエストが届いた公開 API のオリジン（scheme + host）を推定する。
 * ALB 後ろでは X-Forwarded-* が付く想定。Host が localhost のローカル検証用に env で上書き可能。
 *
 * @param {Record<string, string | string[] | undefined>} hdrs
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function resolvePublicApiOriginForStripe(hdrs, env = process.env) {
  const e = env || process.env;
  const fromEnv =
    String(e.STRIPE_WEBHOOK_PUBLIC_API_ORIGIN ?? "").trim() ||
    String(e.PUBLIC_API_ORIGIN ?? "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");

  const h = hdrs || {};
  const xfHost = String(h["x-forwarded-host"] ?? h["X-Forwarded-Host"] ?? "")
    .split(",")[0]
    ?.trim();
  const host = xfHost || String(h.host ?? h.Host ?? "").trim();
  if (!host) return null;

  const xfProto = String(h["x-forwarded-proto"] ?? h["X-Forwarded-Proto"] ?? "")
    .split(",")[0]
    ?.trim()
    .toLowerCase();
  let proto = "https";
  if (xfProto === "http" || xfProto === "https") {
    proto = xfProto;
  } else if (host.includes("localhost") || host.startsWith("127.")) {
    proto = "http";
  }

  return `${proto}://${host}`;
}
