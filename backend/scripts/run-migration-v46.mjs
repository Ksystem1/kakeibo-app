/**
 * v46: receipt_learning_catalog.admin_note 列の欠落を修復
 * 実行: cd backend && npm run db:migrate-v46
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
       AND TABLE_NAME = 'receipt_learning_catalog'
       AND COLUMN_NAME = 'admin_note'`,
    [database],
  );
  const cnt = Number(row?.cnt ?? 0);
  if (cnt > 0) {
    console.log("admin_note 列は既に存在します。スキップしました。");
    process.exit(0);
  }
  await conn.query(
    `ALTER TABLE receipt_learning_catalog
       ADD COLUMN admin_note VARCHAR(255) NULL COMMENT 'admin note' AFTER is_disabled`,
  );
  console.log("admin_note 列を追加しました。");
} finally {
  await conn.end().catch(() => {});
}
