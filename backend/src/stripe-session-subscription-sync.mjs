/**
 * ログイン・GET /auth/me 時に Stripe の Subscription を取得し families / is_premium を同期する。
 * Webhook 欠落や DB だけ is_premium が残るケースの補完。
 */
import Stripe from "stripe";
import { createLogger } from "./logger.mjs";
import { requireStripeSecretKey } from "./stripe-config.mjs";
import {
  pickBestStripeSubscriptionForCustomer,
} from "./stripe-subscription-reconcile-core.mjs";
import {
  familyDbFieldsFromStripeSubscription,
  isUserIdForcedPremiumByEnv,
} from "./subscription-logic.mjs";
import { clearIsPremiumAfterSubscriptionEndedDb } from "./stripe-user-premium-sync.mjs";

const logger = createLogger("stripe-session-sync");

function envFlag(name, defaultTrue = true) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  if (v === "1" || v === "true" || v === "yes") return true;
  return defaultTrue;
}

function syncIntervalSeconds() {
  const raw = Number(process.env.STRIPE_SESSION_SYNC_INTERVAL_SECONDS ?? "900");
  return Number.isFinite(raw) && raw >= 60 ? Math.floor(raw) : 900;
}

function isUnknownColumnError(e) {
  if (!e || typeof e !== "object") return false;
  return e.code === "ER_BAD_FIELD_ERROR" || Number(e.errno) === 1054;
}

/**
 * Webhook と同じ並びで請求対象とみなす家族 1 行（stripe_customer_id 付き）
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 */
async function loadPreferredFamilyStripeBillingRow(pool, userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return null;
  const [rows] = await pool.query(
    `SELECT
       f.id AS family_id,
       TRIM(COALESCE(f.stripe_customer_id, '')) AS stripe_customer_id,
       LOWER(TRIM(COALESCE(f.subscription_status, ''))) AS subscription_status
     FROM family_members fm
     JOIN families f ON f.id = fm.family_id
     WHERE fm.user_id = ?
     ORDER BY
       CASE
         WHEN LOWER(TRIM(COALESCE(f.subscription_status, ''))) IN ('active','trialing','past_due','admin_free','admin_granted') THEN 0
         WHEN TRIM(COALESCE(f.stripe_customer_id, '')) <> '' THEN 1
         ELSE 2
       END,
       COALESCE(f.updated_at, f.created_at, '1970-01-01') DESC,
       fm.id ASC
     LIMIT 1`,
    [uid],
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 * @param {{ bypassThrottle?: boolean }} [options]
 * @returns {Promise<{ didUpdate: boolean; skipped: boolean; reason?: string }>}
 */
export async function maybeSyncStripeSubscriptionForUser(pool, userId, options = {}) {
  const bypassThrottle = options.bypassThrottle === true;
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { didUpdate: false, skipped: true, reason: "bad_user_id" };
  }
  if (!envFlag("STRIPE_SESSION_SUBSCRIPTION_SYNC", true)) {
    return { didUpdate: false, skipped: true, reason: "disabled" };
  }
  if (isUserIdForcedPremiumByEnv(uid)) {
    return { didUpdate: false, skipped: true, reason: "force_active_env" };
  }

  const intervalSec = syncIntervalSeconds();
  if (!bypassThrottle) {
    try {
      const [[row]] = await pool.query(
        `SELECT subscription_stripe_synced_at AS t FROM users WHERE id = ? LIMIT 1`,
        [uid],
      );
      const lastMs = row?.t ? new Date(row.t).getTime() : 0;
      if (lastMs && Number.isFinite(lastMs) && Date.now() - lastMs < intervalSec * 1000) {
        return { didUpdate: false, skipped: true, reason: "throttled" };
      }
    } catch (e) {
      if (isUnknownColumnError(e)) {
        return { didUpdate: false, skipped: true, reason: "column_subscription_stripe_synced_at_missing" };
      }
      throw e;
    }
  }

  const fam = await loadPreferredFamilyStripeBillingRow(pool, uid);
  const cus = fam?.stripe_customer_id ? String(fam.stripe_customer_id).trim() : "";
  if (!cus.startsWith("cus_")) {
    try {
      await pool.query(`UPDATE users SET subscription_stripe_synced_at = NOW(3) WHERE id = ?`, [uid]);
    } catch (e) {
      if (!isUnknownColumnError(e)) throw e;
    }
    return { didUpdate: false, skipped: true, reason: "no_stripe_customer" };
  }

  const famSt = String(fam?.subscription_status ?? "").trim().toLowerCase();
  if (famSt === "admin_free" || famSt === "admin_granted") {
    try {
      await pool.query(`UPDATE users SET subscription_stripe_synced_at = NOW(3) WHERE id = ?`, [uid]);
    } catch (e) {
      if (!isUnknownColumnError(e)) throw e;
    }
    return { didUpdate: false, skipped: true, reason: "admin_free" };
  }

  let stripe;
  try {
    stripe = new Stripe(requireStripeSecretKey());
  } catch {
    return { didUpdate: false, skipped: true, reason: "no_stripe_key" };
  }

  const familyId = Number(fam.family_id);
  let didUpdate = false;

  try {
    const list = await stripe.subscriptions.list({
      customer: cus,
      status: "all",
      limit: 30,
    });
    const best = pickBestStripeSubscriptionForCustomer(list.data);

    if (best) {
      const f = familyDbFieldsFromStripeSubscription(best, Date.now());
      const sid = String(best.id);
      const [up] = await pool.query(
        `UPDATE families SET
           subscription_status = ?,
           subscription_period_end_at = ?,
           subscription_cancel_at_period_end = ?,
           stripe_subscription_id = ?,
           updated_at = NOW(3)
         WHERE id = ?`,
        [
          f.subscription_status,
          f.subscription_period_end_at,
          f.subscription_cancel_at_period_end,
          sid,
          familyId,
        ],
      );
      didUpdate = Number(up?.affectedRows ?? 0) > 0;
      if (f.periodExpiredDemoted) {
        logger.info("stripe.session_sync_period_expired_demoted", {
          userId: uid,
          familyId,
          stripeStatus: best.status,
        });
      }
      await clearIsPremiumAfterSubscriptionEndedDb(
        pool,
        { familyId, customerId: cus },
        { event: "stripe.session_sync", subscriptionId: sid },
      );
    } else {
      const [up] = await pool.query(
        `UPDATE families
         SET subscription_status = 'inactive',
             subscription_period_end_at = NULL,
             subscription_cancel_at_period_end = 0,
             updated_at = NOW(3)
         WHERE id = ? AND TRIM(COALESCE(stripe_customer_id, '')) <> ''`,
        [familyId],
      );
      didUpdate = Number(up?.affectedRows ?? 0) > 0;
      await clearIsPremiumAfterSubscriptionEndedDb(
        pool,
        { familyId, customerId: cus },
        { event: "stripe.session_sync", subscriptionId: null },
      );
    }

    await pool.query(`UPDATE users SET subscription_stripe_synced_at = NOW(3) WHERE id = ?`, [uid]);

    logger.info("stripe.session_sync_done", {
      userId: uid,
      familyId,
      didUpdate,
      customerIdPrefix: cus.slice(0, 14),
    });

    return { didUpdate, skipped: false };
  } catch (e) {
    logger.warn("stripe.session_sync_failed", {
      userId: uid,
      message: String(e?.message || e),
    });
    return { didUpdate: false, skipped: true, reason: "stripe_error" };
  }
}
