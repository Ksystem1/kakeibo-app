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
    best.set(cus, list[0]);
  }
  return best;
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
      });
    }
  }

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
  const premiumUsers = Array.isArray(pRows) ? pRows : [];
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
  };
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
