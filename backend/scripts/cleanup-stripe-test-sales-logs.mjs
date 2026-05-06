/**
 * Stripe テスト決済ログの抽出・削除（既定は dry-run）。
 *
 * 目的:
 * - 期間内の sales_logs から「テストユーザー由来」と判断できる行を抽出
 * - 必要に応じて削除
 *
 * 安全策:
 * - 既定は抽出のみ（削除しない）
 * - 削除時は `--execute` に加えて `ALLOW_LIVE_DB_CLEANUP=YES` が必要
 *
 * 例:
 *   cd backend
 *   node scripts/cleanup-stripe-test-sales-logs.mjs
 *   node scripts/cleanup-stripe-test-sales-logs.mjs --from=2026-04-01 --to=2026-05-01
 *   ALLOW_LIVE_DB_CLEANUP=YES node scripts/cleanup-stripe-test-sales-logs.mjs --execute
 */
import "dotenv/config";
import { getPool } from "../src/db.mjs";

function parseArg(name, fallback = "") {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return String(hit.split("=").slice(1).join("=") ?? "").trim();
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseDateStart(raw, fallback) {
  const v = String(raw || fallback).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return `${v} 00:00:00`;
}

function parseDateEndExclusive(raw, fallback) {
  const v = String(raw || fallback).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return `${v} 00:00:00`;
}

function parseLikeTokens(raw) {
  const src = String(raw || "script_,+test,example.com,@test.,dummy,qa+,sandbox").trim();
  return src
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
    .map((v) => (v.includes("%") ? v : `%${v}%`));
}

async function queryCandidateUsers(pool, likeTokens) {
  if (!Array.isArray(likeTokens) || likeTokens.length === 0) return [];
  const cond = likeTokens.map(() => "LOWER(TRIM(COALESCE(u.email, ''))) LIKE ?").join(" OR ");
  const sql = `SELECT u.id, u.email, u.created_at
               FROM users u
               WHERE (${cond})
               ORDER BY u.id ASC`;
  const [rows] = await pool.query(sql, likeTokens);
  return Array.isArray(rows) ? rows : [];
}

async function queryCandidateSalesLogs(pool, fromStart, toEndExclusive, likeTokens) {
  const conds = ["sl.occurred_at >= ?", "sl.occurred_at < ?"];
  const params = [fromStart, toEndExclusive];

  if (likeTokens.length > 0) {
    const userEmailLike = likeTokens
      .map(() => "LOWER(TRIM(COALESCE(u.email, ''))) LIKE ?")
      .join(" OR ");
    const payloadLike = likeTokens
      .map(() => "LOWER(COALESCE(sl.raw_payload_json, '')) LIKE ?")
      .join(" OR ");
    conds.push(`((${userEmailLike}) OR (${payloadLike}))`);
    params.push(...likeTokens, ...likeTokens);
  }

  const sql = `SELECT
                 sl.id,
                 sl.occurred_at,
                 sl.stripe_source_type,
                 sl.stripe_source_id,
                 sl.stripe_event_id,
                 sl.user_id,
                 sl.family_id,
                 sl.currency,
                 sl.gross_amount,
                 sl.stripe_fee_amount,
                 sl.net_amount,
                 u.email AS user_email
               FROM sales_logs sl
               LEFT JOIN users u ON u.id = sl.user_id
               WHERE ${conds.join(" AND ")}
               ORDER BY sl.occurred_at DESC, sl.id DESC`;
  const [rows] = await pool.query(sql, params);
  return Array.isArray(rows) ? rows : [];
}

async function deleteSalesLogsByIds(pool, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  const [res] = await pool.query(`DELETE FROM sales_logs WHERE id IN (${placeholders})`, ids);
  return Number(res?.affectedRows ?? 0);
}

async function main() {
  const execute = hasFlag("execute");
  const fromStart = parseDateStart(parseArg("from", "2026-04-01"), "2026-04-01");
  const toEndExclusive = parseDateEndExclusive(parseArg("to", "2026-05-01"), "2026-05-01");
  if (!fromStart || !toEndExclusive) {
    console.error("日付形式が不正です。--from=YYYY-MM-DD --to=YYYY-MM-DD（to は排他的）");
    process.exit(1);
  }
  const likeTokens = parseLikeTokens(parseArg("email-like", ""));

  const pool = getPool();
  try {
    const candidateUsers = await queryCandidateUsers(pool, likeTokens);
    const candidateLogs = await queryCandidateSalesLogs(pool, fromStart, toEndExclusive, likeTokens);
    const ids = candidateLogs.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));

    console.log(
      JSON.stringify(
        {
          event: "stripe.test_sales_logs.cleanup.plan",
          execute,
          fromStart,
          toEndExclusive,
          likeTokens,
          candidateUsersCount: candidateUsers.length,
          candidateSalesLogsCount: candidateLogs.length,
          candidateUsersPreview: candidateUsers.slice(0, 20),
          candidateSalesLogsPreview: candidateLogs.slice(0, 30),
        },
        null,
        2,
      ),
    );

    if (!execute) {
      console.log(
        "dry-run のため削除していません。削除実行時は ALLOW_LIVE_DB_CLEANUP=YES を付けて --execute を指定してください。",
      );
      return;
    }

    if (String(process.env.ALLOW_LIVE_DB_CLEANUP ?? "").trim() !== "YES") {
      console.error("削除実行には環境変数 ALLOW_LIVE_DB_CLEANUP=YES が必要です。");
      process.exit(1);
    }

    const deleted = await deleteSalesLogsByIds(pool, ids);
    const remain = await queryCandidateSalesLogs(pool, fromStart, toEndExclusive, likeTokens);

    console.log(
      JSON.stringify(
        {
          event: "stripe.test_sales_logs.cleanup.done",
          deleted,
          remainingCount: remain.length,
          remainingPreview: remain.slice(0, 30),
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

