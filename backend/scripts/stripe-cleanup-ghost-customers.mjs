/**
 * Stripe 顧客を DB（users / families）と照合し、紐づきがない「幽霊顧客」を任意で削除する。
 *
 * 照合:
 * - customers.email → users.email（大文字小文字無視・trim）
 * - metadata: kakeibo_user_id, userId, user_id, kakeiboUserId → users.id
 * - 顧客ID (cus_...) 自体: families.stripe_customer_id, users.stripe_customer_id（列があれば）
 *
 * 既定は一覧のみ（削除しない）。`--execute` 時は確認後に stripe.customers.del()。
 *
 * 実行例:
 *   cd backend && npx dotenv -e .env -- node scripts/stripe-cleanup-ghost-customers.mjs
 *   DRY_RUN は不要 --execute が無い限り削除しない
 *   削除を実行: node scripts/stripe-cleanup-ghost-customers.mjs --execute
 *   非対話: STRIPE_GHOST_CLEANUP_CONFIRM=YES node scripts/stripe-cleanup-ghost-customers.mjs --execute
 */
import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import Stripe from "stripe";
import { getPool } from "../src/db.mjs";
import { requireStripeSecretKey } from "../src/stripe-config.mjs";

const execute = process.argv.includes("--execute");

/**
 * @param {Record<string, string>|null|undefined} metadata
 * @returns {number[]}
 */
function extractMetadataUserIds(metadata) {
  if (!metadata || typeof metadata !== "object") return [];
  const keys = ["kakeibo_user_id", "userId", "user_id", "kakeiboUserId"];
  const out = [];
  for (const k of keys) {
    const v = metadata[k];
    if (v == null || String(v).trim() === "") continue;
    const n = Number(String(v).trim());
    if (Number.isFinite(n) && n > 0) out.push(Math.trunc(n));
  }
  return [...new Set(out)];
}

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {string} customerId
 * @param {string} [email]
 * @param {number[]} metaUserIds
 */
async function isCustomerLinkedInDatabase(pool, customerId, email, metaUserIds) {
  const cus = String(customerId).trim();
  if (!cus.startsWith("cus_")) return true;

  const [famRows] = await pool.query(
    `SELECT 1 AS ok FROM families WHERE TRIM(COALESCE(stripe_customer_id, '')) = ? LIMIT 1`,
    [cus],
  );
  if (Array.isArray(famRows) && famRows.length > 0) return true;

  try {
    const [userStripeRows] = await pool.query(
      `SELECT 1 AS ok FROM users WHERE TRIM(COALESCE(stripe_customer_id, '')) = ? LIMIT 1`,
      [cus],
    );
    if (Array.isArray(userStripeRows) && userStripeRows.length > 0) return true;
  } catch (e) {
    if (e && typeof e === "object" && e.code === "ER_BAD_FIELD_ERROR") {
      /* v12 以降 users から列が無い */
    } else {
      throw e;
    }
  }

  for (const uid of metaUserIds) {
    const [u] = await pool.query(`SELECT 1 AS ok FROM users WHERE id = ? LIMIT 1`, [uid]);
    if (Array.isArray(u) && u.length > 0) return true;
  }

  const em = String(email ?? "").trim().toLowerCase();
  if (em) {
    const [byEmail] = await pool.query(
      `SELECT 1 AS ok FROM users WHERE LOWER(TRIM(COALESCE(email, ''))) = ? LIMIT 1`,
      [em],
    );
    if (Array.isArray(byEmail) && byEmail.length > 0) return true;
  }

  return false;
}

/**
 * @returns {Promise<import("stripe").Stripe.Customer[]>}
 */
async function listAllCustomers(stripe) {
  const all = [];
  let startingAfter;
  for (;;) {
    const page = await stripe.customers.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    all.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return all;
}

async function main() {
  const stripe = new Stripe(requireStripeSecretKey());
  const pool = getPool();

  console.log(
    JSON.stringify(
      { event: "stripe.ghost_cleanup.start", execute, ts: new Date().toISOString() },
      null,
      2,
    ),
  );

  const customers = await listAllCustomers(stripe);
  console.log(JSON.stringify({ event: "stripe.customers.fetched", total: customers.length }, null, 2));

  /** @type {Array<{ id: string; email: string | null; metadata: Record<string, string>; reason: string }>} */
  const candidates = [];

  for (const c of customers) {
    const email = c.email != null && String(c.email).trim() !== "" ? String(c.email).trim() : null;
    const meta = c.metadata && typeof c.metadata === "object" ? c.metadata : {};
    const metaUserIds = extractMetadataUserIds(meta);
    const linked = await isCustomerLinkedInDatabase(pool, c.id, email, metaUserIds);
    if (!linked) {
      candidates.push({
        id: c.id,
        email,
        metadata: meta,
        reason: "not_found_in_db",
      });
    }
  }

  console.log("\n--- 削除候補（DB に照合でヒットしなかった Stripe 顧客）---");
  console.log(JSON.stringify(candidates, null, 2));
  console.log("--- 件数:", candidates.length, "---\n");

  if (candidates.length === 0) {
    console.log("削除候補はありません。終了します。");
    await pool.end();
    return;
  }

  if (!execute) {
    console.log(
      "上記を削除する場合: `node backend/scripts/stripe-cleanup-ghost-customers.mjs --execute` を実行し、表示に従って YES と入力（または非対話で STRIPE_GHOST_CLEANUP_CONFIRM=YES）。",
    );
    await pool.end();
    return;
  }

  const tty = Boolean(input.isTTY && output.isTTY);
  if (tty) {
    const rl = readline.createInterface({ input, output });
    const ans = (await rl.question("これらの顧客を Stripe から削除します。続行するには YES と入力: "))
      .trim();
    rl.close();
    if (ans !== "YES") {
      console.log("中止しました。");
      await pool.end();
      return;
    }
  } else if (String(process.env.STRIPE_GHOST_CLEANUP_CONFIRM ?? "").trim() !== "YES") {
    console.error(
      "非対話モードでは環境変数 STRIPE_GHOST_CLEANUP_CONFIRM=YES が必要です。",
    );
    await pool.end();
    process.exit(1);
  }

  const results = [];
  for (const { id, email } of candidates) {
    try {
      await stripe.customers.del(id);
      results.push({ id, email, ok: true });
    } catch (e) {
      results.push({
        id,
        email,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  console.log("\n--- 削除結果 ---");
  console.log(JSON.stringify(results, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
