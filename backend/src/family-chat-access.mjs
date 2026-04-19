/**
 * 家族チャット（chat_scope = family）のアクセス判定。
 * 単一家族運用: family_members に無くても、家族 ID 1 ＋（users.family_role = ADMIN または is_admin）なら利用可。
 *
 * 環境変数 SINGLE_FAMILY_CHAT_ID（既定 1）で対象 family.id を変えられる。
 */
export const SINGLE_FAMILY_CHAT_ID = (() => {
  const n = Number(process.env.SINGLE_FAMILY_CHAT_ID ?? "1");
  return Number.isFinite(n) && n > 0 ? n : 1;
})();

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 * @param {number} familyId
 */
export async function canAccessFamilyChat(pool, userId, familyId) {
  const [mem] = await pool.query(
    `SELECT 1 AS ok FROM family_members WHERE family_id = ? AND user_id = ? LIMIT 1`,
    [familyId, userId],
  );
  if (Array.isArray(mem) && mem.length > 0 && mem[0]?.ok) return true;
  if (familyId !== SINGLE_FAMILY_CHAT_ID) return false;
  const [urows] = await pool.query(
    `SELECT COALESCE(family_role, 'MEMBER') AS family_role, is_admin FROM users WHERE id = ? LIMIT 1`,
    [userId],
  );
  const u = Array.isArray(urows) && urows[0] ? urows[0] : null;
  if (!u) return false;
  const fr = String(u.family_role ?? "MEMBER")
    .trim()
    .toUpperCase();
  if (fr === "ADMIN") return true;
  if (Number(u.is_admin) === 1) return true;
  return false;
}
