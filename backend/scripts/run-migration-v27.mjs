/**
 * RDS に db/migration_v27_passkey_recovery.sql を適用する。
 * 実行: cd backend && npm run db:migrate-v27
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { getMysqlSslConfig } from "../src/db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const migrationPath = path.resolve(__dirname, "..", "..", "db", "migration_v27_passkey_recovery.sql");
if (!fs.existsSync(migrationPath)) {
  console.error(`マイグレーションが見つかりません: ${migrationPath}`);
  process.exit(1);
}

const sql = fs.readFileSync(migrationPath, "utf8");

const conn = await mysql.createConnection({
  host,
  port,
  user,
  password,
  database,
  multipleStatements: true,
  ssl: getMysqlSslConfig(),
});

try {
  console.log(`接続: ${user}@${host}:${port}/${database}`);
  console.log(`実行: ${migrationPath}`);
  await conn.query(sql);
  console.log("migration_v27_passkey_recovery.sql の適用が完了しました。");
} finally {
  await conn.end();
}
