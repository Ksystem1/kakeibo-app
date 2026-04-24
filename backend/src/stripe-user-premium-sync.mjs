/**
 * Stripe 解約系イベント後: users.is_premium を 0 に戻す（deriveSubscriptionStatus では is_premium=1 が active 扱いのため必須）
 */
import { createLogger } from "./logger.mjs";

const logger = createLogger("stripe-user-premium-sync");

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {{ familyId: number | null; customerId: string }} p
 * @param {{ subscriptionId?: string | null; event?: string }} [ctx]
 */
export async function clearIsPremiumAfterSubscriptionEndedDb(pool, p, ctx = {}) {
  const { familyId, customerId } = p;
  const cus = String(customerId || "").trim();
  let fromFamily = 0;
  let fromUserColumn = 0;

  const uid = Number(familyId);
  if (Number.isFinite(uid) && uid > 0) {
    try {
      const [r] = await pool.query(
        `UPDATE users u
         INNER JOIN family_members fm ON fm.user_id = u.id AND fm.family_id = ?
         SET u.is_premium = 0, u.updated_at = NOW()`,
        [uid],
      );
      fromFamily = Number(r?.affectedRows ?? 0);
    } catch (e) {
      if (!isUnknownColumnError(e)) throw e;
    }
  }

  if (cus.startsWith("cus_")) {
    try {
      const [r2] = await pool.query(
        `UPDATE users
         SET is_premium = 0, updated_at = NOW()
         WHERE TRIM(COALESCE(stripe_customer_id, '')) = ?`,
        [cus],
      );
      fromUserColumn = Number(r2?.affectedRows ?? 0);
    } catch (e) {
      if (!isUnknownColumnError(e)) throw e;
    }
  }

  logger.info("stripe.is_premium.cleared", {
    ...ctx,
    customerId: cus || null,
    familyId: Number.isFinite(uid) && uid > 0 ? uid : null,
    fromFamily,
    fromUserColumn,
  });
}

function isUnknownColumnError(e) {
  if (!e || typeof e !== "object") return false;
  return e.code === "ER_BAD_FIELD_ERROR" || Number(e.errno) === 1054;
}
