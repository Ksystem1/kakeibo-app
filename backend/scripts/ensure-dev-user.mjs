/**
 * 開発用ユーザー dev@example.com が無ければ作成し、users.id を表示する。
 * フロントの VITE_DEV_USER_ID にこの id を合わせる。
 *
 * 実行: cd backend && npm run db:dev-user
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

const email = "dev@example.com";

const conn = await mysql.createConnection({
  host: requireEnv("RDS_HOST"),
  port: Number(process.env.RDS_PORT || "3306"),
  user: requireEnv("RDS_USER"),
  password: requireEnv("RDS_PASSWORD"),
  database: requireEnv("RDS_DATABASE"),
  ssl: getMysqlSslConfig(),
});

try {
  const [existing] = await conn.query(
    "SELECT id FROM users WHERE email = ? LIMIT 1",
    [email],
  );
  if (existing.length > 0) {
    console.log(`既存ユーザーを使用します。id=${existing[0].id}  email=${email}`);
    console.log(
      `フロントの .env に VITE_DEV_USER_ID=${existing[0].id} を設定してください。`,
    );
  } else {
    const [r] = await conn.query(
      `INSERT INTO users (cognito_sub, email, display_name)
       VALUES (NULL, ?, '開発ユーザー')`,
      [email],
    );
    console.log(`ユーザーを作成しました。id=${r.insertId}  email=${email}`);
    console.log(
      `フロントの .env に VITE_DEV_USER_ID=${r.insertId} を設定してください。`,
    );
  }
} finally {
  await conn.end();
}
