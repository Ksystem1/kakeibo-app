/**
 * 公開 GET /user-stats
 * - registeredUserCount: `users` 全行（本アプリの会員。一般的な「profiles」相当の別テーブルは未分離）
 * - onlineUserCount5m: `last_accessed_at` が直近5分以内の行数（「現在オンライン」指標。Supabase Realtime / Firebase presence の代替）
 * - activeUserCount7d: 参考（7日）
 * - count: 旧クライアント向け。未指定時は onlineUserCount5m が取れなければ registered
 */

function isBadFieldError(e) {
  if (!e || typeof e !== "object") return false;
  return String(e.code || "") === "ER_BAD_FIELD_ERROR" || Number(e.errno) === 1054;
}

/**
 * @param {import("mysql2/promise").Pool} pool
 */
export async function getPublicUserStatsPayload(pool) {
  const [[regRow]] = await pool.query(`SELECT COUNT(*) AS c FROM users`);
  const registeredUserCount = Math.max(0, Math.floor(Number(regRow?.c ?? 0)));

  let onlineUserCount5m = null;
  try {
    const [[oRow]] = await pool.query(
      `SELECT COUNT(*) AS c FROM users
       WHERE last_accessed_at IS NOT NULL
         AND last_accessed_at >= (NOW() - INTERVAL 5 MINUTE)`,
    );
    onlineUserCount5m = Math.max(0, Math.floor(Number(oRow?.c ?? 0)));
  } catch (e) {
    if (isBadFieldError(e)) {
      onlineUserCount5m = null;
    } else {
      throw e;
    }
  }

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

  const count =
    onlineUserCount5m != null
      ? onlineUserCount5m
      : activeUserCount7d != null && activeUserCount7d > 0
        ? activeUserCount7d
        : registeredUserCount;

  return {
    registeredUserCount,
    onlineUserCount5m,
    activeUserCount7d: activeUserCount7d,
    count,
    asOf: new Date().toISOString(),
  };
}
