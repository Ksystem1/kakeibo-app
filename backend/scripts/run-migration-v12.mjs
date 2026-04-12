/**
 * RDS に db/migration_v12_families_subscription.sql を適用し、users から families へサブスク情報をコピーする。
 * 実行: cd backend && npm run db:migrate-v12
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
const port = Number(process.env.RDS_PORT || "3306");

const migrationPath = path.resolve(
  __dirname,
  "..",
  "..",
  "db",
  "migration_v12_families_subscription.sql",
);
if (!fs.existsSync(migrationPath)) {
  console.error(`マイグレーションが見つかりません: ${migrationPath}`);
  process.exit(1);
}

const sql = fs.readFileSync(migrationPath, "utf8");

/**
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} tableName
 * @returns {Promise<Set<string>>}
 */
async function getTableColumnNames(conn, tableName) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName],
  );
  return new Set((rows || []).map((r) => String(r.COLUMN_NAME)));
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
  console.log(`実行: ${migrationPath}`);
  await conn.query(sql);
  console.log("migration_v12_families_subscription.sql の適用が完了しました。");

  /**
   * Stripe 系は families が正。users に列が残っている場合のみ users からコピーする。
   * users から Stripe 列を削除済みの環境では SELECT が不要（エラー回避）。
   */
  const userCols = await getTableColumnNames(conn, "users");
  const copyCols = [
    "stripe_customer_id",
    "stripe_subscription_id",
    "subscription_status",
    "subscription_period_end_at",
    "subscription_cancel_at_period_end",
  ].filter((c) => userCols.has(c));

  if (copyCols.length === 0) {
    console.log(
      "users にサブスク関連列がありません。バックフィルをスキップしました（Stripe は families のみの運用とみなします）。",
    );
  } else {
    let orderBy = "updated_at DESC";
    if (userCols.has("stripe_customer_id")) {
      orderBy =
        "(stripe_customer_id IS NOT NULL AND TRIM(stripe_customer_id) <> '') DESC, updated_at DESC";
    }
    const selectList = copyCols.join(", ");

    const [families] = await conn.query(`SELECT id FROM families`);
    const rows = Array.isArray(families) ? families : [];
    let n = 0;
    for (const fr of rows) {
      const fid = Number(fr.id);
      if (!Number.isFinite(fid) || fid <= 0) continue;
      const [src] = await conn.query(
        `SELECT ${selectList}
         FROM users
         WHERE (
           default_family_id = ?
           OR id IN (SELECT user_id FROM family_members WHERE family_id = ?)
         )
         ORDER BY ${orderBy}
         LIMIT 1`,
        [fid, fid],
      );
      if (!Array.isArray(src) || src.length === 0) continue;
      const r = src[0];
      const hasStripe =
        copyCols.includes("stripe_customer_id") &&
        r.stripe_customer_id != null &&
        String(r.stripe_customer_id).trim() !== "";
      const st = copyCols.includes("subscription_status")
        ? String(r.subscription_status ?? "inactive").trim() || "inactive"
        : "inactive";
      const hasNonInactive = st !== "inactive";
      if (!hasStripe && !hasNonInactive) continue;
      await conn.query(
        `UPDATE families SET
           stripe_customer_id = ?,
           stripe_subscription_id = ?,
           subscription_status = ?,
           subscription_period_end_at = ?,
           subscription_cancel_at_period_end = ?,
           updated_at = NOW()
         WHERE id = ?`,
        [
          hasStripe ? String(r.stripe_customer_id).trim() : null,
          copyCols.includes("stripe_subscription_id") && r.stripe_subscription_id != null
            ? String(r.stripe_subscription_id).trim()
            : null,
          st,
          copyCols.includes("subscription_period_end_at")
            ? r.subscription_period_end_at ?? null
            : null,
          copyCols.includes("subscription_cancel_at_period_end") &&
            Number(r.subscription_cancel_at_period_end) === 1
            ? 1
            : 0,
          fid,
        ],
      );
      n += 1;
    }
    console.log(`users → families のバックフィル: ${n} 家族を更新しました。`);
  }
} finally {
  await conn.end();
}
