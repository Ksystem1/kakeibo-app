/**
 * v30: 孤児家族の削除（メンバー0かつ default_family_id からも未参照）
 *      + family_invites があれば期限切れ行を削除
 *
 * 実行: npm run db:migrate-v30（backend ディレクトリから）
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
  "migration_v30_cleanup_orphan_families_and_invites.sql",
);
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
  console.log("migration_v30: 孤児 families を削除しました。");

  try {
    const [r] = await conn.query(`DELETE FROM family_invites WHERE expires_at < NOW()`);
    const aff = Number(r?.affectedRows ?? 0);
    console.log(`family_invites: 期限切れ ${aff} 件を削除しました。`);
  } catch (e) {
    const code = e && typeof e === "object" ? e.code : "";
    if (code === "ER_NO_SUCH_TABLE") {
      console.log("family_invites テーブルなし — スキップ。");
    } else {
      throw e;
    }
  }

  console.log("migration v30 完了。");
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  await conn.end();
}
