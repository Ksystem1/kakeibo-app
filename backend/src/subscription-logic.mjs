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
  const raw = String(subscriptionStatus ?? "inactive").trim();
  if (raw === "") return "inactive";
  const low = raw.toLowerCase();
  /** 旧表記・外部連携用エイリアス（DB 正規値は admin_free） */
  if (low === "admin_granted") return "admin_free";
  return raw;
}

/**
 * @param {Record<string, unknown> | null | undefined} row users 行（ログイン・/auth/me は families と JOIN 済みの subscription_*）
 */
export function deriveSubscriptionStatusFromDbRow(row) {
  if (!row || typeof row !== "object") return "inactive";
  const st = row.subscription_status;
  if (st != null && String(st).trim() !== "") {
    const t = String(st).trim();
    const low = t.toLowerCase();
    if (low === "admin_granted") return "admin_free";
    return t;
  }
  if (row.is_premium != null && Number(row.is_premium) === 1) return "active";
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
  if (status === "admin_free" || status === "admin_granted") return true;
  const endMs = subscriptionPeriodEndMsFromRow(row);
  if (endMs != null && nowMs > endMs) return false;
  if (status === "active" || status === "past_due" || status === "trialing") return true;
  if (status === "canceled" && endMs != null && nowMs <= endMs) return true;
  return false;
}

/**
 * プレミアム機能（レシート AI 等）の利用可否。
 * active / trialing / past_due / canceled（期間内）に加え、admin_free（管理者付与）も true。
 * @param {Record<string, unknown>} row users の一部（subscription_period_end_at 任意）
 * @param {number} userId
 */
export function userHasPremiumSubscriptionAccess(row, userId) {
  return isSubscriptionServiceSubscribed(row, userId);
}

/**
 * DB が古く「active のまま」でも subscription_period_end_at が現在より過去なら
 * inactive 扱いの行に矯正（/auth/me・ログイン表示の確実な非活性化）
 * @param {Record<string, unknown>} row merge 済み users + 優先家族の subscription 列
 * @param {number} userId
 * @param {number} [nowMs]
 */
export function coerceExpiredPaidSubscriptionRowForAuthMe(row, userId, nowMs = Date.now()) {
  if (!row || typeof row !== "object") return row;
  if (isUserIdForcedPremiumByEnv(userId)) return row;
  const eff = String(
    getEffectiveSubscriptionStatus(deriveSubscriptionStatusFromDbRow(row), userId),
  )
    .trim()
    .toLowerCase();
  if (eff === "admin_free" || eff === "admin_granted") return row;
  const endMs = subscriptionPeriodEndMsFromRow(row);
  if (endMs == null || endMs >= nowMs) return row;
  if (eff === "active" || eff === "trialing" || eff === "past_due") {
    return { ...row, subscription_status: "inactive", subscription_cancel_at_period_end: 0 };
  }
  return row;
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
 * GET /auth/me・ログイン: users 行と「優先家族」の subscription をマージ。
 * `loadUserSubscriptionRowFull` の subscription CASE と同等（片側だけ admin_free でも反映）。
 *
 * @param {Record<string, unknown>} userRow queryLogin / queryMe の 1 行
 * @param {Record<string, unknown> | null | undefined} preferredFamilyRow getPreferredFamilySubscriptionRow の結果
 * @returns {Record<string, unknown>}
 */
export function mergeAuthMeSubscriptionWithPreferredFamily(userRow, preferredFamilyRow) {
  if (!userRow || typeof userRow !== "object") return userRow;
  const base = { ...userRow };
  if (!preferredFamilyRow || typeof preferredFamilyRow !== "object") return base;

  const fst = String(preferredFamilyRow.subscription_status ?? "").trim();
  const ust = String(base.subscription_status ?? "").trim();
  const fl = fst.toLowerCase();
  const ul = ust.toLowerCase();

  const adminHit =
    fl === "admin_free" || fl === "admin_granted" || ul === "admin_free" || ul === "admin_granted";

  const premiumFam = ["active", "trialing", "past_due", "admin_free", "admin_granted"].includes(fl);
  const premiumUser = ["active", "trialing", "past_due", "admin_free", "admin_granted"].includes(ul);

  let subscription_status = ust;
  if (adminHit) {
    subscription_status = "admin_free";
  } else if (["active", "trialing", "past_due"].includes(fl)) {
    subscription_status = fst;
  } else if (["active", "trialing", "past_due"].includes(ul)) {
    subscription_status = ust;
  } else {
    subscription_status = fst !== "" ? fst : ust;
  }

  const periodPick = adminHit
    ? preferredFamilyRow.subscription_period_end_at ?? base.subscription_period_end_at
    : premiumFam
      ? preferredFamilyRow.subscription_period_end_at
      : premiumUser
        ? base.subscription_period_end_at
        : preferredFamilyRow.subscription_period_end_at ?? base.subscription_period_end_at;

  const cancelPick = adminHit
    ? preferredFamilyRow.subscription_cancel_at_period_end ?? base.subscription_cancel_at_period_end
    : premiumFam
      ? preferredFamilyRow.subscription_cancel_at_period_end
      : premiumUser
        ? base.subscription_cancel_at_period_end
        : preferredFamilyRow.subscription_cancel_at_period_end ?? base.subscription_cancel_at_period_end;

  return {
    ...base,
    subscription_status,
    subscription_period_end_at:
      periodPick !== undefined ? periodPick : base.subscription_period_end_at,
    subscription_cancel_at_period_end:
      cancelPick !== undefined ? cancelPick : base.subscription_cancel_at_period_end,
    stripe_subscription_id:
      preferredFamilyRow.stripe_subscription_id ?? base.stripe_subscription_id,
  };
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

/**
 * Stripe Subscription → families 同期用の列値。
 * current_period_end が現在より過去なのに active/trialing/past_due のまま返るケースでは DB を inactive に落とし、解約済みが再度 active と書き込まれるのを防ぐ。
 * @param {Record<string, unknown>} sub
 * @param {number} [nowMs]
 * @returns {{
 *   subscription_status: string;
 *   subscription_period_end_at: Date | null;
 *   subscription_cancel_at_period_end: number;
 *   periodExpiredDemoted: boolean;
 * }}
 */
export function familyDbFieldsFromStripeSubscription(sub, nowMs = Date.now()) {
  const statusLow = String(sub?.status ?? "").trim().toLowerCase();
  const periodEndUnix = Number(sub?.current_period_end ?? 0) || 0;
  const periodEndMs = periodEndUnix > 0 ? periodEndUnix * 1000 : null;
  const pe = periodEndUnix > 0 ? new Date(periodEndUnix * 1000) : null;
  const cancelAtEnd = sub?.cancel_at_period_end ? 1 : 0;
  const raw = mapStripeSubscriptionStatusToDb(sub.status);

  let subscription_status = raw;
  let subscription_cancel_at_period_end = cancelAtEnd;
  let periodExpiredDemoted = false;

  if (periodEndMs != null && periodEndMs < nowMs) {
    if (statusLow === "active" || statusLow === "trialing" || statusLow === "past_due") {
      subscription_status = "inactive";
      subscription_cancel_at_period_end = 0;
      periodExpiredDemoted = true;
    }
  }

  return {
    subscription_status,
    subscription_period_end_at: pe,
    subscription_cancel_at_period_end,
    periodExpiredDemoted,
  };
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
  const canon = s === "admin_granted" ? "admin_free" : s;
  return ADMIN_SETTABLE_SUBSCRIPTION_STATUSES.has(canon) ? canon : null;
}

/** クライアントが users.subscription_status を書き換えようとしている疑いがある JSON ボディか */
export function bodyContainsSubscriptionMutationFields(b) {
  if (!b || typeof b !== "object") return false;
  return (
    Object.prototype.hasOwnProperty.call(b, "subscriptionStatus") ||
    Object.prototype.hasOwnProperty.call(b, "subscription_status")
  );
}
