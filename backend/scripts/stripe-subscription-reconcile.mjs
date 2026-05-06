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
import { analyzeStripeDbSubscriptionReconcile } from "../src/stripe-subscription-reconcile-core.mjs";
import { familyDbFieldsFromStripeSubscription } from "../src/subscription-logic.mjs";
import { clearIsPremiumAfterSubscriptionEndedDb } from "../src/stripe-user-premium-sync.mjs";

const fix = process.argv.includes("--fix");

/**
 * @param {import("stripe").Stripe} stripe
 * @param {import("mysql2/promise").Pool} pool
 * @returns {Promise<{ hasMismatches: boolean }>}
 */
async function run(stripe, pool) {
  const analysis = await analyzeStripeDbSubscriptionReconcile(stripe, pool);
  const { byCustomer, ...restBase } = analysis;
  const out = {
    ...restBase,
    fix,
  };

  const { hasMismatches, familyMismatches, userMismatches } = analysis;
  console.log(JSON.stringify(out, null, 2));

  if (fix && hasMismatches) {
    for (const m of familyMismatches) {
      const cus = m.stripeCustomerId;
      const sub = cus ? byCustomer.get(cus) : null;
      if (sub) {
        const f = familyDbFieldsFromStripeSubscription(sub, Date.now());
        const sid = String(sub.id);
        await pool.query(
          `UPDATE families SET
             subscription_status = ?,
             subscription_period_end_at = ?,
             subscription_cancel_at_period_end = ?,
             stripe_subscription_id = ?,
             updated_at = NOW()
           WHERE id = ?`,
          [
            f.subscription_status,
            f.subscription_period_end_at,
            f.subscription_cancel_at_period_end,
            sid,
            m.familyId,
          ],
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
