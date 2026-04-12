/**
 * Stripe 等で更新する users.subscription_status / is_premium と連携。
 * DB 値は小文字推奨（'active' のみ有効扱い）。is_premium=1 も active と同等。
 */

/** カンマ・セミコロン・空白区切りの users.id。Stripe 前のローカル検証用。 */
export function parseForceActiveUserIds() {
  const raw = process.env.SUBSCRIPTION_FORCE_ACTIVE_USER_IDS ?? "";
  const ids = [];
  for (const part of String(raw).split(/[,;\s]+/)) {
    const n = Number(String(part).trim());
    if (Number.isFinite(n) && n > 0) ids.push(n);
  }
  return ids;
}

export function isUserIdForcedPremiumByEnv(userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return false;
  return parseForceActiveUserIds().includes(uid);
}

/**
 * DB（および is_premium）から得た状態文字列に、環境変数モックを上乗せする。
 */
export function getEffectiveSubscriptionStatus(subscriptionStatus, userId) {
  if (isUserIdForcedPremiumByEnv(userId)) return "active";
  return String(subscriptionStatus ?? "inactive");
}

/**
 * @param {Record<string, unknown> | null | undefined} row users 行の一部
 */
export function deriveSubscriptionStatusFromDbRow(row) {
  if (!row || typeof row !== "object") return "inactive";
  if (row.is_premium != null && Number(row.is_premium) === 1) return "active";
  const st = row.subscription_status;
  if (st != null && String(st).trim() !== "") return String(st).trim();
  return "inactive";
}

export function isSubscriptionActive(subscriptionStatus) {
  return String(subscriptionStatus ?? "").trim().toLowerCase() === "active";
}

/** 管理者が PATCH /admin/users/:id で設定可能な subscription_status（VARCHAR(32) 内） */
export const ADMIN_SETTABLE_SUBSCRIPTION_STATUSES = new Set([
  "inactive",
  "active",
  "past_due",
  "canceled",
  "trialing",
]);

/**
 * @param {unknown} raw
 * @returns {string | null} 正規化済み値、または不正なら null
 */
export function normalizeAdminSettableSubscriptionStatus(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s || s.length > 32) return null;
  return ADMIN_SETTABLE_SUBSCRIPTION_STATUSES.has(s) ? s : null;
}

/** クライアントが users.subscription_status を書き換えようとしている疑いがある JSON ボディか */
export function bodyContainsSubscriptionMutationFields(b) {
  if (!b || typeof b !== "object") return false;
  return (
    Object.prototype.hasOwnProperty.call(b, "subscriptionStatus") ||
    Object.prototype.hasOwnProperty.call(b, "subscription_status")
  );
}
