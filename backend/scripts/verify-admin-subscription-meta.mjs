/**
 * GET /admin/users の meta.subscriptionStatusWritable と同じ判定根拠を検証する。
 * 使い方: cd backend && node scripts/verify-admin-subscription-meta.mjs
 */
import "dotenv/config";
import { getPool, isRdsConfigured } from "../src/db.mjs";

async function main() {
  if (!isRdsConfigured()) {
    console.log("[verify-admin-meta] SKIP: RDS_HOST 未設定");
    process.exit(0);
  }
  const pool = getPool();
  try {
    try {
      await pool.query("SELECT subscription_status FROM users WHERE 1=0");
      console.log("[verify-admin-meta] probe SELECT subscription_status: OK（列あり）");
      console.log(
        "[verify-admin-meta] デプロイ済み API がこのロジックなら meta.subscriptionStatusWritable は true になります。",
      );
    } catch (e) {
      console.log(
        "[verify-admin-meta] probe FAIL（列なしまたは権限等）:",
        String(e?.message || e),
      );
      console.log(
        "[verify-admin-meta] この状態では meta.subscriptionStatusWritable は false です。",
      );
      process.exitCode = 1;
      return;
    }

    const [rows] = await pool.query(
      "SELECT id, subscription_status FROM users ORDER BY id ASC LIMIT 3",
    );
    console.log("[verify-admin-meta] sample rows:", rows);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("[verify-admin-meta] error:", e);
  process.exit(1);
});
