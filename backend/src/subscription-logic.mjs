/**
 * Stripe Webhook / 管理者 PATCH で更新するサブスク状態と is_premium の連携。
 * v12 以降: 主に families（家族単位）。API の user 行は JOIN 済みの subscription_* を参照。
 * DB: VARCHAR(32)（migration v8 users / v12 families）。Stripe Subscription.status を小文字で保存。
 * admin_free: 管理者付与の無料プレミアム枠（Stripe 外。アプリ側でプレミアム同等扱い）。
 * is_premium=1（users）はレシートAI 等では active と同等。
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
 * @param {Record<string, unknown> | null | undefined} row users 行（ログイン・/auth/me は families と JOIN 済みの subscription_*）
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
 * DB 行の subscription_period_end_at をミリ秒に（不正なら null）
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {number | null}
 */
export function subscriptionPeriodEndMsFromRow(row) {
  const raw = row?.subscription_period_end_at;
  if (raw == null || raw === "") return null;
  const end = raw instanceof Date ? raw : new Date(raw);
  if (!Number.isFinite(end.getTime())) return null;
  return end.getTime();
}

/**
 * Stripe 準拠: サービス利用可能か（current_period_end を過ぎるまでは cancel_at_period_end でも有効）。
 * - active / past_due / trialing: 期間終了前なら利用可
 * - canceled: current_period_end（DB の subscription_period_end_at）まで利用可
 * @param {Record<string, unknown> | null | undefined} row users/families JOIN 行（subscription_period_end_at 任意）
 * @param {number} userId
 * @param {number} [nowMs=Date.now()]
 * @returns {boolean}
 */
export function isSubscriptionServiceSubscribed(row, userId, nowMs = Date.now()) {
  if (isUserIdForcedPremiumByEnv(userId)) return true;
  const status = String(
    getEffectiveSubscriptionStatus(deriveSubscriptionStatusFromDbRow(row), userId),
  ).trim()
    .toLowerCase();
  /** 請求期間に依存しない管理者付与（期限なしでプレミアム同等） */
  if (status === "admin_free") return true;
  const endMs = subscriptionPeriodEndMsFromRow(row);
  if (endMs != null && nowMs > endMs) return false;
  if (status === "active" || status === "past_due" || status === "trialing") return true;
  if (status === "canceled" && endMs != null && nowMs <= endMs) return true;
  return false;
}

/**
 * プレミアム機能（ナビスキン・レシート AI 等）の利用可否。
 * @param {Record<string, unknown>} row users の一部（subscription_period_end_at 任意）
 * @param {number} userId
 */
export function userHasPremiumSubscriptionAccess(row, userId) {
  return isSubscriptionServiceSubscribed(row, userId);
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
  "admin_free",
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
