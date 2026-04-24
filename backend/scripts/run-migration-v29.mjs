/**
 * v29: 空メールの仮割当 → 未設定パスワードにプレースホルダbcrypt → email/password_hash NOT NULL
 * 既存の email / password_hash は UPDATE で埋めたうえで NOT NULL 化（デフォルト句に依存しない）
 *
 * 実行: npm run db:migrate-v29（リポジトリルート）または cd backend && npm run db:migrate-v29
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

async function countNullEmails() {
  const [[r]] = await conn.query(
    `SELECT COUNT(*) AS c FROM users WHERE email IS NULL OR TRIM(COALESCE(email, '')) = ''`,
  );
  return Number(r?.c || 0);
}

async function countNullPasswords() {
  const [[r]] = await conn.query(
    `SELECT COUNT(*) AS c FROM users WHERE password_hash IS NULL OR TRIM(COALESCE(password_hash, '')) = ''`,
  );
  return Number(r?.c || 0);
}

try {
  console.log(`接続: ${user}@${host}:${port}/${database}`);
  const sql = fs.readFileSync(migrationPath, "utf8");
  await conn.query(sql);

  if ((await countNullEmails()) > 0) {
    console.error("v29: 空メールのバックフィル後も email 未設定の行が残っています。手動で確認してください。");
    process.exit(1);
  }

  const placeholder = await hashPassword(USERS_NO_PASSWORD_PLACEHOLDER);
  const [phRows] = await conn.query(
    `SELECT id FROM users WHERE password_hash IS NULL OR TRIM(COALESCE(password_hash, '')) = ''`,
  );
  const rows = Array.isArray(phRows) ? phRows : [];
  if (rows.length > 0) {
    for (const row of rows) {
      await conn.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [placeholder, row.id]);
    }
    console.log(`password_hash プレースホルダを ${rows.length} 件に設定しました。`);
  } else {
    console.log("password_hash が未設定のユーザーはありません。");
  }

  if ((await countNullPasswords()) > 0) {
    console.error("v29: password プレースホルダ設定後も NULL/空の行が残っています。中断します。");
    process.exit(1);
  }

  // 既存データに NULL が無いことを確認してから NOT NULL 化（DEFAULT 句は新規行向けにのみ有効のため、
  // 移行の信頼性は UPDATE 完了に依拠する）
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
