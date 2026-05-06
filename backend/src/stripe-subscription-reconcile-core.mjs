/**
 * Stripe 全サブスクと DB（families / users.is_premium）の比較（読み取り専用）
 * バッチ: scripts/stripe-subscription-reconcile.mjs
 * API: GET /admin/subscription-reconcile
 */
import {
  isSubscriptionServiceSubscribed,
  isUserIdForcedPremiumByEnv,
  mapStripeSubscriptionStatusToDb,
} from "./subscription-logic.mjs";
import { clearIsPremiumAfterSubscriptionEndedDb } from "./stripe-user-premium-sync.mjs";

/**
 * @param {import("stripe").Stripe.Subscription} a
 * @param {import("stripe").Stripe.Subscription} b
 */
function subscriptionPrecedence(a, b) {
  const n = (sub) => {
    const s = String(sub.status || "").toLowerCase();
    if (s === "active") return 5;
    if (s === "trialing") return 4;
    if (s === "past_due") return 3;
    if (s === "paused" || s === "unpaid") return 2;
    if (s === "canceled") return 1;
    return 0;
  };
  const d = n(a) - n(b);
  if (d !== 0) return d;
  return Number(b.current_period_end ?? 0) - Number(a.current_period_end ?? 0);
}

/**
 * @param {import("stripe").Stripe.Subscription} sub
 */
function extractCustomerIdFromSubscription(sub) {
  const c = sub.customer;
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && c.id) return String(c.id);
  return null;
}

/**
 * @param {import("stripe").Stripe} stripe
 * @returns {Promise<import("stripe").Stripe.Subscription[]>}
 */
export async function listAllStripeSubscriptions(stripe) {
  const all = [];
  let startingAfter;
  for (;;) {
    const page = await stripe.subscriptions.list({
      status: "all",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    all.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return all;
}

/**
 * @param {import("stripe").Stripe.Subscription[]} subs
 * @returns {Map<string, import("stripe").Stripe.Subscription>}
 */
export function bestSubscriptionByCustomer(subs) {
  /** @type {Map<string, import("stripe").Stripe.Subscription[]>} */
  const byCus = new Map();
  for (const s of subs) {
    const c = extractCustomerIdFromSubscription(s);
    if (!c) continue;
    if (!byCus.has(c)) byCus.set(c, []);
    byCus.get(c).push(s);
  }
  const best = new Map();
  for (const [cus, list] of byCus) {
    list.sort(subscriptionPrecedence);
    /** comparison は昇順（n が小さいほど先頭）→ 最有力は末尾 */
    best.set(cus, list[list.length - 1]);
  }
  return best;
}

/**
 * 同一顧客に複数 Subscription があるとき、優先度が最も高い 1 件（API のログイン同期など）
 * @param {import("stripe").Stripe.Subscription[]} subs
 * @returns {import("stripe").Stripe.Subscription | null}
 */
export function pickBestStripeSubscriptionForCustomer(subs) {
  if (!Array.isArray(subs) || subs.length === 0) return null;
  const list = [...subs];
  list.sort(subscriptionPrecedence);
  return list[list.length - 1] ?? null;
}

/**
 * @param {string} a
 * @param {string} b
 */
function sameSubscriptionStatusForReconcile(a, b) {
  return String(a ?? "")
    .trim()
    .toLowerCase() ===
    String(b ?? "")
      .trim()
      .toLowerCase();
}

function isAdminFreeFamilyStatus(st) {
  const s = String(st ?? "")
    .trim()
    .toLowerCase();
  return s === "admin_free" || s === "admin_granted";
}

/**
 * バッチの --fix 用: Stripe 上の顧客別代表サブスク
 * @param {import("stripe").Stripe} stripe
 * @param {import("mysql2/promise").Pool} pool
 * @returns {Promise<{
 *   at: string;
 *   hasMismatches: boolean;
 *   stripeSubscriptionCount: number;
 *   familyRowCount: number;
 *   familyMismatches: Array<Record<string, unknown>>;
 *   userMismatches: Array<Record<string, unknown>>;
 *   byCustomer: Map<string, import("stripe").Stripe.Subscription>;
 * }>}
 */
export async function analyzeStripeDbSubscriptionReconcile(stripe, pool) {
  const allSubs = await listAllStripeSubscriptions(stripe);
  const byCustomer = bestSubscriptionByCustomer(allSubs);

  const [famRows] = await pool.query(
    `SELECT id, stripe_customer_id, subscription_status, stripe_subscription_id, subscription_period_end_at
     FROM families
     WHERE TRIM(COALESCE(stripe_customer_id, '')) LIKE 'cus_%'`,
  );
  const families = Array.isArray(famRows) ? famRows : [];

  /** @type {Array<Record<string, unknown>>} */
  const familyMismatches = [];

  for (const f of families) {
    const cus = String(f.stripe_customer_id).trim();
    const dbSt = f.subscription_status != null ? String(f.subscription_status).trim() : "inactive";
    if (isAdminFreeFamilyStatus(dbSt)) continue;
    const win = byCustomer.get(cus) || null;
    const expected = win
      ? mapStripeSubscriptionStatusToDb(win.status)
      : "inactive";
    if (!sameSubscriptionStatusForReconcile(dbSt, expected)) {
      familyMismatches.push({
        kind: "family_subscription_status",
        familyId: Number(f.id),
        stripeCustomerId: cus,
        db: dbSt,
        stripeExpected: expected,
        stripeBestSubscriptionId: win ? win.id : null,
        descriptionJa:
          "家族の契約状態（DB）と、Stripe の代表サブスクリプションから期待される状態が一致しません。",
      });
    }
  }

  let premiumUsers = [];
  let userPremiumCheckSkipped = false;
  let userPremiumSkipReasonJa = null;
  try {
    const [pRows] = await pool.query(
      `SELECT u.id AS user_id, u.is_premium, f.id AS family_id, f.subscription_status AS f_status,
              f.stripe_customer_id, f.subscription_period_end_at AS f_period_end,
              f.subscription_cancel_at_period_end AS f_cancel
       FROM users u
       INNER JOIN family_members fm ON fm.user_id = u.id
       INNER JOIN families f ON f.id = fm.family_id
       WHERE u.is_premium = 1
         AND TRIM(COALESCE(f.stripe_customer_id, '')) LIKE 'cus_%'`,
    );
    premiumUsers = Array.isArray(pRows) ? pRows : [];
  } catch (e) {
    if (e?.code === "ER_BAD_FIELD_ERROR" || Number(e?.errno) === 1054) {
      userPremiumCheckSkipped = true;
      userPremiumSkipReasonJa =
        "users テーブルに is_premium 列がありません（db/migration_v9_users_is_premium.sql 未適用の可能性）。家族行の不整合照合のみ表示します。";
    } else {
      throw e;
    }
  }
  const userMismatches = [];

  for (const u of premiumUsers) {
    const uid = Number(u.user_id);
    if (isUserIdForcedPremiumByEnv(uid)) continue;
    const fStatus = u.f_status != null ? String(u.f_status).trim() : "inactive";
    if (isAdminFreeFamilyStatus(fStatus)) continue;
    const rowAsIfNoIsPremium = {
      is_premium: 0,
      subscription_status: fStatus,
      subscription_period_end_at: u.f_period_end ?? null,
      subscription_cancel_at_period_end: Number(u.f_cancel ?? 0) === 1 ? 1 : 0,
    };
    if (Number(u.is_premium) === 1 && !isSubscriptionServiceSubscribed(rowAsIfNoIsPremium, uid)) {
      const cus = String(u.stripe_customer_id).trim();
      userMismatches.push({
        kind: "user_is_premium_stale",
        userId: uid,
        familyId: Number(u.family_id),
        stripeCustomerId: cus,
        note: "is_premium=1 だが、家族行の契約・期間だけだと有効なサブとみなされない",
        descriptionJa:
          "ユーザーの「プレミアム」がオンですが、家族の契約状況・期間から見ると有料プラン有効扱いになりません。DBを修正するとプレミアム表示を契約状況に揃えます。",
      });
    }
  }

  const hasMismatches = familyMismatches.length > 0 || userMismatches.length > 0;

  return {
    at: new Date().toISOString(),
    hasMismatches,
    stripeSubscriptionCount: allSubs.length,
    familyRowCount: families.length,
    familyMismatches,
    userMismatches,
    byCustomer,
    userPremiumCheckSkipped,
    userPremiumSkipReasonJa: userPremiumCheckSkipped ? userPremiumSkipReasonJa : null,
  };
}

/**
 * 管理者: 1 件の家族不整合を Stripe 代表サブスクに合わせる（バッチ --fix の 1 行分）
 * @param {import("stripe").Stripe} stripe
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} familyId
 * @returns {Promise<{ ok: true } | { ok: false; error: string; messageJa: string }>}
 */
export async function applyOneFamilyMismatch(stripe, pool, familyId) {
  const analysis = await analyzeStripeDbSubscriptionReconcile(stripe, pool);
  const m = analysis.familyMismatches.find((x) => Number(x.familyId) === Number(familyId));
  if (!m) {
    return {
      ok: false,
      error: "not_mismatch",
      messageJa:
        "この家族は現在不整合一覧にありません。表示を再読み込みするか、既に他の手順で解消済みの可能性があります。",
    };
  }
  const { byCustomer } = analysis;
  const cus = m.stripeCustomerId;
  const sub = cus ? byCustomer.get(cus) : null;
  if (sub) {
    const pe = sub.current_period_end
      ? new Date(Number(sub.current_period_end) * 1000)
      : null;
    const cAtEnd = sub.cancel_at_period_end ? 1 : 0;
    const dbS = mapStripeSubscriptionStatusToDb(sub.status);
    const sid = String(sub.id);
    await pool.query(
      `UPDATE families SET
         subscription_status = ?,
         subscription_period_end_at = ?,
         subscription_cancel_at_period_end = ?,
         stripe_subscription_id = ?,
         updated_at = NOW()
       WHERE id = ?`,
      [dbS, pe, cAtEnd, sid, m.familyId],
    );
    await clearIsPremiumAfterSubscriptionEndedDb(
      pool,
      { familyId: m.familyId, customerId: cus },
      { event: "admin.reconcile.apply", subscriptionId: sid },
    );
  } else {
    await pool.query(
      `UPDATE families
       SET subscription_status = 'inactive', subscription_period_end_at = NULL,
           subscription_cancel_at_period_end = 0, updated_at = NOW()
       WHERE id = ?`,
      [m.familyId],
    );
    await clearIsPremiumAfterSubscriptionEndedDb(
      pool,
      { familyId: m.familyId, customerId: cus },
      { event: "admin.reconcile.apply" },
    );
  }
  return { ok: true };
}

/**
 * 管理者: 1 件のユーザー is_premium 不整合を解消（該当ユーザーのプレミアムをオフに揃える）
 * @param {import("stripe").Stripe} stripe
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 * @param {number} familyId
 * @returns {Promise<{ ok: true } | { ok: false; error: string; messageJa: string }>}
 */
export async function applyOneUserMismatch(stripe, pool, userId, familyId) {
  const analysis = await analyzeStripeDbSubscriptionReconcile(stripe, pool);
  const m = analysis.userMismatches.find(
    (x) => Number(x.userId) === Number(userId) && Number(x.familyId) === Number(familyId),
  );
  if (!m) {
    return {
      ok: false,
      error: "not_mismatch",
      messageJa:
        "この行は不整合一覧にないか、データベースに is_premium 列が無いため照合できていません。",
    };
  }
  await clearIsPremiumAfterSubscriptionEndedDb(
    pool,
    { familyId: m.familyId, customerId: m.stripeCustomerId },
    { event: "admin.reconcile.apply.user" },
  );
  return { ok: true };
}

/**
 * API 向け: Map は含めない（JSON 化不可）
 * @param {import("stripe").Stripe} stripe
 * @param {import("mysql2/promise").Pool} pool
 */
export async function compareStripeSubscriptionsWithDb(stripe, pool) {
  const { byCustomer, ...rest } = await analyzeStripeDbSubscriptionReconcile(stripe, pool);
  return rest;
}
