/**
 * GET /admin/access-stats — 管理者向けアクセス指標（users.last_accessed_at ベース）
 */

function isBadFieldError(e) {
  if (!e || typeof e !== "object") return false;
  return String(e.code || "") === "ER_BAD_FIELD_ERROR" || Number(e.errno) === 1054;
}

/**
 * @param {import("mysql2/promise").Pool} pool
 */
export async function getAdminAccessStatsPayload(pool) {
  const asOf = new Date().toISOString();
  try {
    const [[row]] = await pool.query(
      `SELECT
         COUNT(*) AS total_users,
         SUM(CASE WHEN last_accessed_at >= (NOW() - INTERVAL 5 MINUTE) THEN 1 ELSE 0 END) AS active_5m,
         SUM(CASE WHEN last_accessed_at >= (NOW() - INTERVAL 1 HOUR) THEN 1 ELSE 0 END) AS active_1h,
         SUM(CASE WHEN last_accessed_at >= (NOW() - INTERVAL 24 HOUR) THEN 1 ELSE 0 END) AS active_24h,
         SUM(CASE WHEN last_accessed_at >= (NOW() - INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS active_7d,
         SUM(CASE WHEN last_accessed_at >= (NOW() - INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS active_30d,
         SUM(CASE WHEN last_accessed_at IS NOT NULL THEN 1 ELSE 0 END) AS users_with_access_timestamp
       FROM users`,
    );
    const [activeRows] = await pool.query(
      `SELECT
         id,
         email,
         login_name,
         display_name,
         last_accessed_at
       FROM users
       WHERE last_accessed_at >= (NOW() - INTERVAL 5 MINUTE)
       ORDER BY last_accessed_at DESC
       LIMIT 100`,
    );
    const nu = (v) => Math.max(0, Math.floor(Number(v ?? 0)));
    const activeUsers5m = (Array.isArray(activeRows) ? activeRows : []).map((r) => ({
      id: nu(r?.id),
      email: r?.email == null ? "" : String(r.email),
      login_name: r?.login_name == null ? null : String(r.login_name),
      display_name: r?.display_name == null ? null : String(r.display_name),
      last_accessed_at: r?.last_accessed_at == null ? null : String(r.last_accessed_at),
    }));
    return {
      as_of: asOf,
      total_users: nu(row?.total_users),
      active_5m: nu(row?.active_5m),
      active_1h: nu(row?.active_1h),
      active_24h: nu(row?.active_24h),
      active_7d: nu(row?.active_7d),
      active_30d: nu(row?.active_30d),
      users_with_access_timestamp: nu(row?.users_with_access_timestamp),
      active_users_5m: activeUsers5m,
      migration_missing_last_accessed_at: false,
    };
  } catch (e) {
    if (isBadFieldError(e)) {
      const [[regRow]] = await pool.query(`SELECT COUNT(*) AS c FROM users`);
      const total = Math.max(0, Math.floor(Number(regRow?.c ?? 0)));
      return {
        as_of: asOf,
        total_users: total,
        active_5m: null,
        active_1h: null,
        active_24h: null,
        active_7d: null,
        active_30d: null,
        users_with_access_timestamp: null,
        active_users_5m: [],
        migration_missing_last_accessed_at: true,
      };
    }
    throw e;
  }
}
