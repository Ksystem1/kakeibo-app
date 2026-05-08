/**
 * Stripe を呼ばずにユーザーを DB から物理削除する（運用用 CLI）。
 * 本番 API キーでテストモードの顧客 ID を解約できない場合、管理画面の DELETE が 502 になる件の回避に使う。
 *
 * 既定はドライラン（表示のみ）。`--execute` のときだけ削除。
 *
 * 例:
 *   cd backend && npx dotenv -e .env -- node scripts/delete-user-db-only.mjs --email=script_001231@yahoo.co.jp
 *   実際に削除:
 *   npx dotenv -e .env -- node scripts/delete-user-db-only.mjs --email=script_001231@yahoo.co.jp --execute
 *   メール重複時は id を指定:
 *   npx dotenv -e .env -- node scripts/delete-user-db-only.mjs --user-id=123 --execute
 */
import "dotenv/config";
import { getPool } from "../src/db.mjs";
import { performUserAccountDeletionDbOnly } from "../src/account-delete.mjs";

/**
 * @param {string[]} argv
 * @returns {{ email: string | null; userId: number | null; execute: boolean }}
 */
function parseArgs(argv) {
  let email = null;
  let userId = null;
  let execute = false;
  for (const a of argv) {
    if (a === "--execute") {
      execute = true;
      continue;
    }
    if (a.startsWith("--email=")) {
      const v = a.slice("--email=".length).trim();
      email = v || null;
      continue;
    }
    if (a.startsWith("--user-id=")) {
      const n = Number(a.slice("--user-id=".length).trim(), 10);
      userId = Number.isFinite(n) && n > 0 ? n : null;
      continue;
    }
  }
  return { email, userId, execute };
}

async function resolveTargetUserId(pool, email, explicitUserId) {
  if (explicitUserId != null) {
    const [[row]] = await pool.query(
      `SELECT id, email, is_admin, COALESCE(is_child, 0) AS is_child
       FROM users WHERE id = ? LIMIT 1`,
      [explicitUserId],
    );
    if (!row) {
      throw new Error(`ユーザー id=${explicitUserId} が見つかりません`);
    }
    return row;
  }
  if (!email || !String(email).trim()) {
    throw new Error("--email=... または --user-id=... を指定してください");
  }
  const em = String(email).trim();
  const [rows] = await pool.query(
    `SELECT id, email, is_admin, COALESCE(is_child, 0) AS is_child
     FROM users
     WHERE LOWER(TRIM(COALESCE(email, ''))) = LOWER(?)
     ORDER BY id ASC`,
    [em],
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`メール "${em}" のユーザーが見つかりません`);
  }
  if (rows.length > 1) {
    console.error("同一メールのユーザーが複数あります。どれか一つを --user-id で指定してください:");
    for (const r of rows) {
      console.error(`  id=${r.id}  email=${r.email}  is_admin=${r.is_admin}  is_child=${r.is_child}`);
    }
    throw new Error("複数一致のため中止しました");
  }
  return rows[0];
}

async function assertNotLastAdmin(pool, target) {
  if (Number(target.is_admin) !== 1) return;
  const [[cntRow]] = await pool.query(`SELECT COUNT(*) AS c FROM users WHERE is_admin = 1`);
  if (Number(cntRow?.c) <= 1) {
    throw new Error("最後の管理者は削除できません（通常の管理画面と同じ制限）");
  }
}

async function main() {
  const { email, userId: argUserId, execute } = parseArgs(process.argv.slice(2));
  const pool = getPool();
  try {
    const target = await resolveTargetUserId(pool, email, argUserId);
    const uid = Number(target.id);
    console.log("対象ユーザー:");
    console.log(JSON.stringify(target, null, 2));

    await assertNotLastAdmin(pool, target);

    if (!execute) {
      console.log(
        "\n（ドライラン）Stripe は呼びません。削除するには同じ引数に --execute を付けて再実行してください。",
      );
      return;
    }

    await performUserAccountDeletionDbOnly(pool, uid);
    console.log(`\n完了: user id=${uid} を DB から削除しました（Stripe API は未使用）。`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
