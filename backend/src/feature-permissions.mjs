/**
 * プラン別機能権限（feature_permissions + 利用者のサブスク判定）
 */
import { userHasPremiumSubscriptionAccess } from "./subscription-logic.mjs";

const FEATURE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeFeatureKey(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!FEATURE_KEY_RE.test(s)) return null;
  return s;
}

/**
 * @param {string} minPlan
 * @returns {"standard" | "premium"}
 */
export function normalizeMinPlan(minPlan) {
  const s = String(minPlan ?? "")
    .trim()
    .toLowerCase();
  return s === "premium" ? "premium" : "standard";
}

/**
 * @param {import("mysql2/promise").Pool} pool
 * @returns {Promise<Array<{ feature_key: string; min_plan: string; label_ja: string | null; sort_order: number }> | null>}
 */
export async function fetchAllFeaturePermissions(pool) {
  try {
    const [rows] = await pool.query(
      `SELECT feature_key, min_plan, label_ja, sort_order
       FROM feature_permissions
       ORDER BY sort_order ASC, feature_key ASC`,
    );
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    if (e?.code === "ER_NO_SUCH_TABLE") return null;
    throw e;
  }
}

/**
 * 既存 feature_key の min_plan のみ更新（マイグレで投入した行を管理画面から変更）
 * @returns {Promise<boolean>} 更新できたら true
 */
export async function setFeaturePermissionMinPlan(pool, featureKey, minPlan) {
  const mp = normalizeMinPlan(minPlan);
  const [res] = await pool.query(
    `UPDATE feature_permissions SET min_plan = ?, updated_at = NOW() WHERE feature_key = ?`,
    [mp, featureKey],
  );
  return Number(res?.affectedRows ?? 0) > 0;
}

/**
 * @param {boolean} isPremium userHasPremiumSubscriptionAccess
 * @returns {"standard" | "premium"}
 */
export function effectivePlanForUser(isPremium) {
  return isPremium ? "premium" : "standard";
}

/**
 * @param {"standard"|"premium"} effectivePlan
 * @param {"standard"|"premium"} minPlan
 */
export function planMeetsMinRequirement(effectivePlan, minPlan) {
  if (minPlan === "premium") return effectivePlan === "premium";
  return true;
}

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 * @param {string} featureKey normalized
 * @param {Record<string, unknown>} subRow loadUserSubscriptionRowFull
 */
export async function evaluateFeatureForUser(pool, userId, featureKey, subRow) {
  const rows = await fetchAllFeaturePermissions(pool);
  const isPremium = userHasPremiumSubscriptionAccess(subRow, userId);
  const effectivePlan = effectivePlanForUser(isPremium);

  if (rows == null) {
    return {
      allowed: true,
      feature: featureKey,
      minPlan: null,
      effectivePlan,
      reason: "table_missing",
    };
  }

  const row = rows.find((r) => String(r.feature_key).trim() === featureKey);
  if (!row) {
    return {
      allowed: true,
      feature: featureKey,
      minPlan: null,
      effectivePlan,
      reason: "not_configured",
    };
  }

  const minPlan = normalizeMinPlan(row.min_plan);
  const allowed = planMeetsMinRequirement(effectivePlan, minPlan);
  return {
    allowed,
    feature: featureKey,
    minPlan,
    effectivePlan,
    labelJa: row.label_ja == null ? null : String(row.label_ja),
    reason: allowed ? "ok" : "plan_insufficient",
  };
}

/**
 * 全機能の許可マップ（1 リクエスト用）
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 * @param {Record<string, unknown>} subRow
 */
export async function evaluateAllFeaturesForUser(pool, userId, subRow) {
  const rows = await fetchAllFeaturePermissions(pool);
  const isPremium = userHasPremiumSubscriptionAccess(subRow, userId);
  const effectivePlan = effectivePlanForUser(isPremium);

  if (rows == null) {
    return { effectivePlan, items: [], tableMissing: true };
  }

  const items = rows.map((r) => {
    const key = String(r.feature_key).trim();
    const minPlan = normalizeMinPlan(r.min_plan);
    const allowed = planMeetsMinRequirement(effectivePlan, minPlan);
    return {
      feature: key,
      allowed,
      minPlan,
      labelJa: r.label_ja == null ? null : String(r.label_ja),
    };
  });

  return { effectivePlan, items, tableMissing: false };
}
