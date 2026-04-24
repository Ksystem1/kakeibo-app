/**
 * ユーザー退会（物理削除）+ Stripe 即時解約（利用者のいない家族のサブスクリプション）
 */
import Stripe from "stripe";
import { sqlUserFamilyIdExpr } from "./family-billing-scope.mjs";
import { requireStripeSecretKey } from "./stripe-config.mjs";

const FAM_U = sqlUserFamilyIdExpr("u");

/**
 * @param {import("mysql2/promise").Pool|import("mysql2/promise").Connection} pool
 * @param {number} userId
 */
export async function assertUserMayDeleteAccount(pool, userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) {
    const e = new Error("INVALID_USER");
    e.code = "InvalidUser";
    throw e;
  }
  const [[u]] = await pool.query(
    `SELECT id, COALESCE(is_child, 0) AS is_child FROM users WHERE id = ? LIMIT 1`,
    [uid],
  );
  if (!u) {
    const e = new Error("NOT_FOUND");
    e.code = "UserNotFound";
    throw e;
  }
  if (Number(u.is_child) === 1) {
    const e = new Error("子どもアカウントの退会は保護者の管理画面からプロフィールを削除してください。");
    e.code = "ChildAccountCannotSelfDelete";
    throw e;
  }
  const [owners] = await pool.query(
    `SELECT fm.family_id
     FROM family_members fm
     WHERE fm.user_id = ?
       AND fm.role = 'owner'
       AND (SELECT COUNT(*) FROM family_members fm2 WHERE fm2.family_id = fm.family_id) > 1
     LIMIT 1`,
    [uid],
  );
  if (Array.isArray(owners) && owners.length > 0) {
    const e = new Error(
      "家族の主管理者（オーナー）のまま、ほかのメンバーがいるため退会できません。先に他メンバーを外す・オーナー譲渡・家族グループの整理を行ってください。",
    );
    e.code = "OwnerMustTransferOrDisband";
    throw e;
  }
}

/**
 * 請求先家族がそのユーザー1人だけのとき、有効な Stripe 定期を即時解約
 * 他にメンバーがいる場合はサブスクリプションに触れない
 *
 * @returns {Promise<{ cancelled: boolean; subscriptionId: string | null; reason: string }>}
 */
export async function cancelStripeForSoleMemberFamilyIfNeeded(pool, userId) {
  const uid = Number(userId);
  const [rows] = await pool.query(
    `SELECT f.id AS family_id,
            TRIM(COALESCE(f.stripe_customer_id, '')) AS stripe_customer_id,
            (SELECT COUNT(*) FROM family_members fm0 WHERE fm0.family_id = f.id) AS member_count
     FROM users u
     INNER JOIN families f ON f.id = ${FAM_U}
     WHERE u.id = ? LIMIT 1`,
    [uid],
  );
  if (!Array.isArray(rows) || !rows[0]) {
    return { cancelled: false, subscriptionId: null, reason: "no_billing_family" };
  }
  const row = rows[0];
  const memberCount = Number(row.member_count || 0);
  if (memberCount > 1) {
    return { cancelled: false, subscriptionId: null, reason: "other_members" };
  }
  const cus = String(row.stripe_customer_id || "");
  if (!cus.startsWith("cus_")) {
    return { cancelled: false, subscriptionId: null, reason: "no_stripe_customer" };
  }
  const stripe = new Stripe(requireStripeSecretKey());
  const list = await stripe.subscriptions.list({ customer: cus, status: "all", limit: 20 });
  const toCancel = list.data.filter((s) => ["active", "trialing", "past_due"].includes(s.status));
  if (toCancel.length === 0) {
    return { cancelled: false, subscriptionId: null, reason: "no_active_subscription" };
  }
  let lastId = null;
  for (const s of toCancel) {
    await stripe.subscriptions.cancel(s.id);
    lastId = s.id;
  }
  return { cancelled: true, subscriptionId: lastId, reason: "cancelled" };
}

/**
 * 子ユーザ → 本人の順に物理 DELETE（FK CASCADE 前提。親より先に子を消す）
 */
export async function deleteUserAccountCompletely(conn, userId) {
  const uid = Number(userId);
  const [kids] = await conn.query(
    `SELECT id FROM users WHERE parent_id = ? AND COALESCE(is_child, 0) = 1`,
    [uid],
  );
  for (const k of kids || []) {
    const cid = Number(k.id);
    if (Number.isFinite(cid) && cid > 0) {
      await conn.query(`DELETE FROM users WHERE id = ?`, [cid]);
    }
  }
  const [r] = await conn.query(`DELETE FROM users WHERE id = ?`, [uid]);
  const affected = Number(r?.affectedRows ?? 0);
  if (affected !== 1) {
    const e = new Error("ユーザーの削除に失敗しました");
    e.code = "DeleteUserFailed";
    throw e;
  }
  await conn.query(
    `DELETE f FROM families f
     WHERE NOT EXISTS (SELECT 1 FROM family_members m WHERE m.family_id = f.id)`,
  );
}
