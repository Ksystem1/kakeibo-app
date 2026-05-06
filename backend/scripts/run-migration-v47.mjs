/**
 * users.subscription_stripe_synced_at — ログイン時の Stripe 同期スロットル用。
 * 実行: cd backend && npm run db:migrate-v47
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { getMysqlSslConfig } from "../src/db.mjs";

function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    console.error(`環境変数 ${name} が未設定です。backend/.env を確認してください。`);
    process.exit(1);
  }
  return v;
}

const host = requireEnv("RDS_HOST");
const user = requireEnv("RDS_USER");
const password = requireEnv("RDS_PASSWORD");
const database = requireEnv("RDS_DATABASE");
const portRaw = Number(process.env.RDS_PORT || "3306");
const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 3306;

const conn = await mysql.createConnection({
  host,
  port,
  user,
  password,
  database,
  ssl: getMysqlSslConfig(),
});

try {
  console.log(`接続: ${user}@${host}:${port}/${database}`);
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'subscription_stripe_synced_at'`,
    [database],
  );
  const cnt = Number(row?.cnt ?? 0);
  if (cnt > 0) {
    console.log("subscription_stripe_synced_at 列は既に存在します。スキップしました。");
    process.exit(0);
  }
  await conn.query(
    `ALTER TABLE users
       ADD COLUMN subscription_stripe_synced_at DATETIME(3) NULL
         COMMENT 'Stripe session sync throttle (login /auth/me)'`,
  );
  console.log("subscription_stripe_synced_at 列を追加しました。");
} finally {
  await conn.end().catch(() => {});
}
