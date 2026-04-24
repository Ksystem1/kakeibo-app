/**
 * RDS に db/migration_v28_authenticator_credential_id_text.sql を適用する。
 * utf8mb4 では credential_id 全長 UNIQUE が「Specified key was too long」になるため、
 * 先に UNIQUE を外し、列変更後に credential_id(255) の接頭辞 UNIQUE を付け直す。
 * 実行: npm run db:migrate-v28（リポジトリルート）または cd backend && npm run db:migrate-v28
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

const migrationPath = path.resolve(
  __dirname,
  "..",
  "..",
  "db",
  "migration_v28_authenticator_credential_id_text.sql",
);
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
  console.log("migration_v28_authenticator_credential_id_text.sql の適用が完了しました。");
} finally {
  await conn.end();
}
