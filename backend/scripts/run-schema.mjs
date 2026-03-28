/**
 * RDS 上の DB に db/schema.sql を一括適用する（初回テーブル作成用）。
 * 実行: backend ディレクトリで npm run db:schema
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

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
const port = Number(process.env.RDS_PORT || "3306");

const schemaPath = path.resolve(__dirname, "..", "..", "db", "schema.sql");
if (!fs.existsSync(schemaPath)) {
  console.error(`スキーマが見つかりません: ${schemaPath}`);
  process.exit(1);
}

const sql = fs.readFileSync(schemaPath, "utf8");

const conn = await mysql.createConnection({
  host,
  port,
  user,
  password,
  database,
  multipleStatements: true,
  ssl: process.env.RDS_SSL === "true" ? {} : undefined,
});

try {
  console.log(`接続: ${user}@${host}:${port}/${database}`);
  console.log(`実行: ${schemaPath}`);
  await conn.query(sql);
  console.log("schema.sql の適用が完了しました。");
} finally {
  await conn.end();
}
