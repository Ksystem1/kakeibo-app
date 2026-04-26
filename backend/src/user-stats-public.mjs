/**
 * 公開 GET /user-stats 用: 登録ユーザー数と直近7日に API を利用したユーザー数（last_accessed_at 利用）。
 */

function isBadFieldError(e) {
  if (!e || typeof e !== "object") return false;
  return String(e.code || "") === "ER_BAD_FIELD_ERROR" || Number(e.errno) === 1054;
}

/**
 * @param {import("mysql2/promise").Pool} pool
 * @returns {Promise<{
 *   count: number,
 *   registeredUserCount: number,
 *   activeUserCount7d: number | null,
 *   asOf: string
 * }>}
 */
export async function getPublicUserStatsPayload(pool) {
  const [[regRow]] = await pool.query(`SELECT COUNT(*) AS c FROM users`);
  const registeredUserCount = Math.max(0, Math.floor(Number(regRow?.c ?? 0)));
  let activeUserCount7d = null;
  try {
    const [[aRow]] = await pool.query(
      `SELECT COUNT(*) AS c FROM users
       WHERE last_accessed_at IS NOT NULL
         AND last_accessed_at >= (NOW() - INTERVAL 7 DAY)`,
    );
    activeUserCount7d = Math.max(0, Math.floor(Number(aRow?.c ?? 0)));
  } catch (e) {
    if (isBadFieldError(e)) {
      activeUserCount7d = null;
    } else {
      throw e;
    }
  }
  let count;
  if (activeUserCount7d != null) {
    count = activeUserCount7d > 0 ? activeUserCount7d : registeredUserCount;
  } else {
    count = registeredUserCount;
  }
  return {
    count,
    registeredUserCount,
    activeUserCount7d: activeUserCount7d,
    asOf: new Date().toISOString(),
  };
}
