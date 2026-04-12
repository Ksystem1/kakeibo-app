/**
 * Stripe Webhook / 管理者 PATCH で更新する users.subscription_status / is_premium と連携。
 * DB: VARCHAR(32)（migration v8）。Stripe Subscription.status を小文字で保存（incomplete 系は inactive に正規化）。
 * is_premium=1 もレシートAI 等では active と同等。
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
  const s = String(subscriptionStatus ?? "").trim().toLowerCase();
  return s === "active" || s === "trialing";
}

/**
 * プレミアム機能（ナビスキン・レシート AI 等）の利用可否。
 * - active / trialing は利用可（解約予定で期間内のケースも Stripe 上は多くは active のまま）
 * - canceled でも請求期間終了日時まで利用可（即時解約などの稀なケース）
 * @param {Record<string, unknown>} row users の一部（subscription_period_end_at 任意）
 * @param {number} userId
 */
export function userHasPremiumSubscriptionAccess(row, userId) {
  const status = getEffectiveSubscriptionStatus(deriveSubscriptionStatusFromDbRow(row), userId);
  if (isSubscriptionActive(status)) return true;
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "past_due") return true;
  if (s === "canceled") {
    const raw = row?.subscription_period_end_at;
    if (raw == null || raw === "") return false;
    const end = raw instanceof Date ? raw : new Date(raw);
    if (!Number.isFinite(end.getTime())) return false;
    return Date.now() <= end.getTime();
  }
  return false;
}

/**
 * API 応答用: 期間終了・解約予定フラグ
 * @param {Record<string, unknown>} row
 */
export function buildUserSubscriptionApiFields(row) {
  const raw = row?.subscription_period_end_at;
  let subscriptionPeriodEndAt = null;
  if (raw != null && raw !== "") {
    const d = raw instanceof Date ? raw : new Date(raw);
    if (Number.isFinite(d.getTime())) subscriptionPeriodEndAt = d.toISOString();
  }
  const subscriptionCancelAtPeriodEnd =
    Number(row?.subscription_cancel_at_period_end) === 1;
  return { subscriptionPeriodEndAt, subscriptionCancelAtPeriodEnd };
}

/**
 * Stripe Subscription.status → users.subscription_status（32 文字以内）
 * @see https://docs.stripe.com/api/subscriptions/object#subscription_object-status
 */
export function mapStripeSubscriptionStatusToDb(stripeStatus) {
  const s = String(stripeStatus || "").trim().toLowerCase();
  if (s === "incomplete" || s === "incomplete_expired") return "inactive";
  if (s === "active") return "active";
  if (s === "trialing") return "trialing";
  if (s === "past_due") return "past_due";
  if (s === "canceled") return "canceled";
  if (s === "unpaid") return "unpaid";
  if (s === "paused") return "paused";
  return "inactive";
}

/** 管理者が PATCH /admin/users/:id で設定可能（Stripe と整合） */
export const ADMIN_SETTABLE_SUBSCRIPTION_STATUSES = new Set([
  "inactive",
  "active",
  "past_due",
  "canceled",
  "trialing",
  "unpaid",
  "paused",
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
