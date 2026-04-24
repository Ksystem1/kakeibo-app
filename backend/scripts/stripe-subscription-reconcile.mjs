/**
 * 定期同期: Stripe の有効/全体サブスクリプション一覧と families の subscription_status / users.is_premium を比較する。
 * - 既定: 不整合を JSON で標準出力し、不整合があれば終了コード 1
 * - --fix: families を Stripe 上の最優先サブスク状態に揃え、is_premium を 1 残りなら 0 へ
 *
 * 週1回等の想定例（cron / GitHub Actions）:
 *   cd backend && node scripts/stripe-subscription-reconcile.mjs
 * 不整合時: 管理者（users.is_admin=1 の実メール、+ ADMIN_NOTIFY_EXTRA_EMAILS）へ SES で通知（SES_SOURCE_EMAIL 要）
 *   STRIPE_RECONCILE_EMAIL=0 でメール抑止
 *
 * 環境: STRIPE_SECRET_KEY, RDS_*, SES_SOURCE_EMAIL, AWS 認証
 */
import "dotenv/config";
import Stripe from "stripe";
import { sendStripeReconcileAlertEmailIfNeeded } from "../src/admin-email-notify.mjs";
import { getPool } from "../src/db.mjs";
import { requireStripeSecretKey } from "../src/stripe-config.mjs";
import {
  isSubscriptionServiceSubscribed,
  isUserIdForcedPremiumByEnv,
  mapStripeSubscriptionStatusToDb,
} from "../src/subscription-logic.mjs";
import { clearIsPremiumAfterSubscriptionEndedDb } from "../src/stripe-user-premium-sync.mjs";

const fix = process.argv.includes("--fix");

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
 * @returns {Promise<import("stripe").Stripe.Subscription[]>}
 */
async function listAllSubscriptions(stripe) {
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
function bestSubscriptionByCustomer(subs) {
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
 * @param {import("stripe").Stripe} stripe
 * @param {import("mysql2/promise").Pool} pool
 * @returns {Promise<{ hasMismatches: boolean }>}
 */
async function run(stripe, pool) {
  const allSubs = await listAllSubscriptions(stripe);
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

  const out = {
    at: new Date().toISOString(),
    fix,
    stripeSubscriptionCount: allSubs.length,
    familyRowCount: families.length,
    familyMismatches,
    userMismatches,
  };

  const hasMismatches = familyMismatches.length > 0 || userMismatches.length > 0;
  console.log(JSON.stringify(out, null, 2));

  if (fix && hasMismatches) {
    for (const m of familyMismatches) {
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
          { event: "stripe.reconcile.fix", subscriptionId: sid },
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
          { event: "stripe.reconcile.fix" },
        );
      }
    }
    for (const m of userMismatches) {
      await clearIsPremiumAfterSubscriptionEndedDb(
        pool,
        { familyId: m.familyId, customerId: m.stripeCustomerId },
        { event: "stripe.reconcile.fix" },
      );
    }
    console.log(JSON.stringify({ event: "stripe.reconcile.fix_done", at: new Date().toISOString() }, null, 2));
  }

  if (hasMismatches) {
    const reportForEmail = {
      ...out,
      fixAttempted: Boolean(fix),
    };
    const emailResult = await sendStripeReconcileAlertEmailIfNeeded(pool, {
      hasMismatches: true,
      reportJson: reportForEmail,
      fix,
    });
    console.log(
      JSON.stringify(
        { event: "stripe.reconcile.admin_email", at: new Date().toISOString(), emailResult },
        null,
        2,
      ),
    );
  }

  return { hasMismatches };
}

const stripe = new Stripe(requireStripeSecretKey());
const pool = getPool();
run(stripe, pool)
  .then((r) => {
    if (!fix && r.hasMismatches) process.exit(1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    if (pool) pool.end().catch(() => {});
  });
