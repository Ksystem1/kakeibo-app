/**
 * v45 backfill: receipt_ocr_corrections -> receipt_learning_catalog
 * 実行: cd backend && npm run db:backfill-v45
 *
 * RESET_RECEIPT_LEARNING_CATALOG=1 は先頭で TRUNCATE する。
 * プロセスを途中で止めるとカタログが空のまま残るので、必ず同一実行で最後まで完了させること。
 */
import "dotenv/config";
import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { getMysqlSslConfig } from "../src/db.mjs";
import { normalizeVendorForMatch } from "../src/receipt-learn.mjs";

const SQL_Q_YEAR_MONTH_COL = "`year_month`";

function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    console.error(`環境変数 ${name} が未設定です。backend/.env を確認してください。`);
    process.exit(1);
  }
  return v;
}

function normalizeReceiptLearningToken(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[　]/g, "")
    .replace(/[()（）【】\[\]{}「」『』<>＜＞:：;；,，.。・]/g, "");
}

function receiptLearningYearMonth(rawDate) {
  const ymd = String(rawDate ?? "").trim().replace(/\//g, "-");
  if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    const y = Number(ymd.slice(0, 4));
    if (Number.isFinite(y) && y >= 2000 && y <= 2100) return ymd.slice(0, 7);
  }
  return "0000-00";
}

function buildCatalogRow(snapshot, categoryNameHint) {
  const vendorLabel = String(snapshot?.vendorName ?? "").trim().slice(0, 120);
  const vendorNorm = normalizeVendorForMatch(vendorLabel).slice(0, 191);
  if (!vendorNorm) return null;
  const ym = receiptLearningYearMonth(snapshot?.date);
  const totalRaw = Number(snapshot?.totalAmount ?? Number.NaN);
  const totalAmount = Number.isFinite(totalRaw) && totalRaw > 0 ? Math.round(totalRaw) : null;
  const tokens = Array.from(
    new Set(
      (Array.isArray(snapshot?.items) ? snapshot.items : [])
        .map((it) => normalizeReceiptLearningToken(it?.name ?? ""))
        .filter((t) => t.length >= 2 && !/^\d+$/.test(t))
        .slice(0, 40),
    ),
  )
    .sort((a, b) => a.localeCompare(b, "ja"))
    .slice(0, 8);
  const itemTokens = tokens.length > 0 ? tokens.join("|").slice(0, 255) : null;
  const canonical = JSON.stringify({ v: vendorNorm, k: itemTokens ?? "", c: categoryNameHint ?? "" });
  const fingerprint = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
  return {
    fingerprint,
    vendorNorm,
    vendorLabel: vendorLabel || null,
    yearMonth: ym,
    totalAmount,
    itemTokens,
    categoryNameHint:
      categoryNameHint != null && String(categoryNameHint).trim() !== ""
        ? String(categoryNameHint).trim().slice(0, 100)
        : null,
  };
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
  const reset = /^(1|true|yes)$/i.test(String(process.env.RESET_RECEIPT_LEARNING_CATALOG ?? ""));
  if (reset) {
    await conn.query("TRUNCATE TABLE receipt_learning_catalog");
    console.log("receipt_learning_catalog を TRUNCATE しました");
  }
  const [rows] = await conn.query(
    `SELECT r.id, r.ocr_snapshot_json, r.category_id, c.name AS category_name
     FROM receipt_ocr_corrections r
     LEFT JOIN categories c ON c.id = r.category_id
     ORDER BY r.id ASC`,
  );
  let scanned = 0;
  let upserted = 0;
  for (const row of rows ?? []) {
    scanned += 1;
    let snap;
    try {
      snap = JSON.parse(String(row?.ocr_snapshot_json ?? "{}"));
    } catch {
      continue;
    }
    const catalog = buildCatalogRow(snap, row?.category_name ?? null);
    if (!catalog) continue;
    await conn.query(
      `INSERT INTO receipt_learning_catalog
        (fingerprint, vendor_norm, vendor_label, ${SQL_Q_YEAR_MONTH_COL}, total_amount, item_tokens, category_name_hint,
         sample_count, is_disabled, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, NOW(), NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         vendor_label = CASE
           WHEN VALUES(vendor_label) IS NULL THEN vendor_label
           WHEN vendor_label IS NULL OR CHAR_LENGTH(VALUES(vendor_label)) > CHAR_LENGTH(vendor_label)
             THEN VALUES(vendor_label)
           ELSE vendor_label
         END,
         category_name_hint = COALESCE(VALUES(category_name_hint), category_name_hint),
         sample_count = sample_count + 1,
         last_seen_at = NOW(),
         updated_at = CURRENT_TIMESTAMP`,
      [
        catalog.fingerprint,
        catalog.vendorNorm,
        catalog.vendorLabel,
        catalog.yearMonth,
        catalog.totalAmount,
        catalog.itemTokens,
        catalog.categoryNameHint,
      ],
    );
    upserted += 1;
  }
  const [[countRow]] = await conn.query(
    `SELECT COUNT(*) AS row_count, COALESCE(SUM(sample_count),0) AS sample_count
     FROM receipt_learning_catalog`,
  );
  console.log(
    JSON.stringify({
      scanned,
      upserted,
      catalog_rows: Number(countRow?.row_count ?? 0),
      catalog_samples: Number(countRow?.sample_count ?? 0),
    }),
  );
} finally {
  await conn.end().catch(() => {});
}

