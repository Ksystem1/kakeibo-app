/**
 * v29: 空メールの仮割当 → 未設定パスワードにプレースホルダbcrypt → email/password_hash NOT NULL
 * パスキー専用ユーザーはパスワードログイン不可（プレースホルダ）のまま。パスキー・リカバリは従来どおり。
 *
 * 実行: cd backend && npm run db:migrate-v29
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { getMysqlSslConfig } from "../src/db.mjs";
import { USERS_NO_PASSWORD_PLACEHOLDER, hashPassword } from "../src/auth-logic.mjs";

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

const migrationPath = path.resolve(__dirname, "..", "..", "db", "migration_v29_users_email_password_notnull.sql");
if (!fs.existsSync(migrationPath)) {
  console.error(`マイグレーションが見つかりません: ${migrationPath}`);
  process.exit(1);
}

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
  const sql = fs.readFileSync(migrationPath, "utf8");
  await conn.query(sql);

  const placeholder = await hashPassword(USERS_NO_PASSWORD_PLACEHOLDER);
  const [phRows] = await conn.query(
    `SELECT id FROM users WHERE password_hash IS NULL OR TRIM(COALESCE(password_hash, '')) = ''`,
  );
  const ids = phRows;
  if (Array.isArray(ids) && ids.length > 0) {
    for (const row of ids) {
      await conn.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [placeholder, row.id]);
    }
    console.log(`password_hash プレースホルダを ${ids.length} 件に設定しました。`);
  } else {
    console.log("password_hash が未設定のユーザーはありません。");
  }

  await conn.query(
    `ALTER TABLE users MODIFY COLUMN email VARCHAR(255) NOT NULL COMMENT 'ログイン用メール（仮: legacy-nomail-@users.kakeibo.internal 形式あり）'`,
  );
  await conn.query(
    `ALTER TABLE users MODIFY COLUMN password_hash VARCHAR(255) NOT NULL COMMENT 'bcrypt（移行プレースホルダ可）'`,
  );
  console.log("users.email / users.password_hash を NOT NULL にしました。migration v29 完了。");
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  await conn.end();
}
