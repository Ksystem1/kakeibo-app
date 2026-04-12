/**
 * Lambda / Express 共通ルータ
 */
import crypto from "node:crypto";
import { stripApiPathPrefix } from "./api-path.mjs";
import { tryAuthRoutes, getDefaultFamilyId } from "./auth-routes.mjs";
import { hashPassword, resolveUserId } from "./auth-logic.mjs";
import { buildCorsHeaders } from "./cors-config.mjs";
import { getPool, isRdsConfigured, pingDatabase } from "./db.mjs";
import { createLogger } from "./logger.mjs";
import {
  analyzeReceiptImageBytes,
  decodeImageBuffer,
} from "./textract-receipt.mjs";
import { seedDefaultCategoriesIfEmpty } from "./category-defaults.mjs";
import {
  buildReceiptOcrSnapshot,
  receiptOcrMatchKey,
} from "./receipt-learn.mjs";
import {
  mergeDuplicateCategories,
  normalizeCategoryNameKey,
} from "./category-utils.mjs";
import {
  askBedrockAdvisor,
  askBedrockReceiptAssistant,
  inferReceiptImageMediaTypeFromBuffer,
} from "./ai-advisor-service.mjs";
import {
  deriveSubscriptionStatusFromDbRow,
  getEffectiveSubscriptionStatus,
  isSubscriptionActive,
  isUserIdForcedPremiumByEnv,
  normalizeAdminSettableSubscriptionStatus,
  bodyContainsSubscriptionMutationFields,
} from "./subscription-logic.mjs";

const logger = createLogger("api");

function logError(event, e, extra = {}) {
  logger.error(event, e, extra);
}

/** 一般ユーザー向け API では DB の subscription を書き換えられない（管理者 PATCH のみ可） */
function rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors) {
  if (!bodyContainsSubscriptionMutationFields(b)) return null;
  return json(
    400,
    {
      error: "InvalidRequest",
      detail: "サブスクリプション状態は管理者のみが変更できます",
    },
    hdrs,
    skipCors,
  );
}

/** クライアントの debugForceReceiptTier を受け付けるか（本番は既定オフ） */
function isReceiptSubscriptionDebugAllowed() {
  const flag = String(process.env.RECEIPT_DEBUG_SUBSCRIPTION_TIER ?? "").trim();
  if (flag === "1" || flag.toLowerCase() === "true") return true;
  return String(process.env.NODE_ENV).toLowerCase() !== "production";
}

function json(statusCode, body, reqHeaders, skipCors) {
  const cors = skipCors ? {} : buildCorsHeaders(reqHeaders);
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...cors,
    },
    body: JSON.stringify(body),
  };
}

function routeKey(method, path) {
  const p = path.replace(/\/$/, "") || "/";
  return `${method} ${p}`;
}

/** 収入は 0 円可。支出は正の数のみ。 */
function validateTransactionAmount(kind, amt) {
  if (!Number.isFinite(amt) || amt < 0) {
    return { ok: false, error: "金額が不正です" };
  }
  if (kind === "income") {
    return { ok: true };
  }
  if (amt <= 0) {
    return {
      ok: false,
      error: "支出の金額は正の数である必要があります",
    };
  }
  return { ok: true };
}

function buildAdvisorFallbackReply(message, ctx) {
  const income = Number(ctx?.incomeTotal ?? 0);
  const expense = Number(ctx?.expenseTotal ?? 0);
  const rest = Math.max(0, Math.round(income - expense));
  const top = Array.isArray(ctx?.topCategories) ? ctx.topCategories[0] : null;
  const topName = top?.name ? String(top.name) : "変動費";
  const topTotal = Number(top?.total ?? 0);
  const msg = String(message ?? "");
  const lower = msg.toLowerCase();

  if (msg.includes("あといくら") || msg.includes("残り")) {
    return `今月の残り予算は${rest.toLocaleString("ja-JP")}円です。${topName}の上限を先に決めると、使い過ぎを防ぎやすくなります。`;
  }
  if (msg.includes("解析") || msg.includes("読み取り") || msg.includes("読取")) {
    return "レシート画面で「レシート取込」を押して画像を選ぶと、合計・日付・カテゴリ候補が自動入力されます。内容確認後に「登録」を押せば家計簿へ保存できます。";
  }
  if (msg.includes("登録方法") || msg.includes("登録") || lower.includes("how to register")) {
    return "家計簿の「取引を追加」で種別・カテゴリ・日付・金額を入力し「追加」を押すと登録できます。レシート取込なら読み取り後に内容確認して「登録」を押してください。";
  }
  if (msg.includes("使い方")) {
    return `「固定費を減らしたい」「${topName}を抑えたい」のように、カテゴリ名つきで質問すると具体案を返しやすいです。今月は${topName}が${topTotal.toLocaleString("ja-JP")}円なので、まずはここから見直しましょう。`;
  }
  if (msg.includes("食費")) {
    return `食費は「週予算」を先に決めるのが効果的です。今週分を封筒方式で分けると、月末のオーバーを防ぎやすくなります。`;
  }
  return `まずは固定費（通信費・保険・サブスク）を見直し、次に${topName}の上限を先に決めるのがおすすめです。今月の残り予算は${rest.toLocaleString("ja-JP")}円です。`;
}

function normalizeTxMemo(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().slice(0, 500);
  return s === "" ? null : s;
}

async function verifyUserInFamily(pool, userId, familyId) {
  if (familyId == null || !Number.isFinite(Number(familyId))) return false;
  const [rows] = await pool.query(
    `SELECT 1 AS ok FROM family_members WHERE family_id = ? AND user_id = ? LIMIT 1`,
    [familyId, userId],
  );
  return Array.isArray(rows) && rows.length > 0;
}

/** レシート summary.date 等を SQL DATE 比較用 YYYY-MM-DD に寄せる */
function normalizeReceiptDateForSql(raw) {
  const t = String(raw ?? "")
    .trim()
    .replace(/\//g, "-");
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (!m) return "";
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

const RECEIPT_CATEGORY_KEYWORDS = {
  food: [
    "りんご",
    "バナナ",
    "野菜",
    "肉",
    "魚",
    "牛乳",
    "卵",
    "パン",
    "米",
    "弁当",
    "飲料",
    "ジュース",
    "スーパー",
    "コンビニ",
  ],
  daily: ["ティッシュ", "洗剤", "シャンプー", "歯ブラシ", "トイレットペーパー", "日用品"],
  transport: ["電車", "バス", "タクシー", "駐車", "ガソリン", "高速", "ic"],
  utility: ["電気", "ガス", "水道", "通信", "wifi", "インターネット", "携帯"],
  medical: ["薬", "病院", "診療", "処方", "クリニック"],
  leisure: ["映画", "カフェ", "外食", "レジャー", "趣味", "書籍"],
};

const RECEIPT_CATEGORY_ALIASES = {
  food: ["食費", "食品", "食料品", "飲食", "スーパー", "グロサリー", "grocery", "food"],
  daily: ["日用品", "雑貨", "生活用品", "ドラッグ", "ドラッグストア"],
  transport: ["交通", "交通費", "電車", "バス", "タクシー", "ガソリン", "駐車場"],
  utility: ["水道", "光熱費", "電気", "ガス", "通信", "ネット", "携帯"],
  medical: ["医療", "病院", "薬", "薬局", "ドラッグ"],
  leisure: ["娯楽", "交際", "外食", "趣味", "レジャー"],
};

/** 店舗名に現れやすい語（履歴の次に、明細キーワードより店舗を強く効かせる） */
const RECEIPT_VENDOR_TAG_HINTS = {
  leisure: [
    "ディズニー",
    "ディズニーランド",
    "ディズニーシー",
    "ユニバーサル",
    "usj",
    "映画館",
    "シネマ",
    "イオンシネマ",
  ],
  food: [
    "セブンイレブン",
    "セブン",
    "ローソン",
    "ファミリーマート",
    "ファミマ",
    "イオン",
    "まいばすけっと",
    "マツキヨ",
    "マツモトキヨシ",
    "スターバックス",
    "スタバ",
    "マクドナルド",
    "マック",
    "すき家",
    "吉野家",
    "はま寿司",
    "スシロー",
    "くら寿司",
  ],
  daily: ["ダイソー", "セリア", "キャンドゥ", "無印"],
  transport: ["jr", "地下鉄", "メトロ", "モバイルsuica", "pasmo"],
};

function normalizeKeyword(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, "").replace(/[　]/g, "");
}

function normalizeReceiptCategoryName(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[　・/]/g, "");
}

function pickCategoryIdByAiName(aiName, categoryRows) {
  const target = normalizeReceiptCategoryName(aiName);
  if (!target) return null;
  let partial = null;
  for (const r of categoryRows || []) {
    const nm = normalizeReceiptCategoryName(r?.name ?? "");
    if (!nm) continue;
    if (nm === target) return Number(r.id);
    if (!partial && (nm.includes(target) || target.includes(nm))) {
      partial = Number(r.id);
    }
  }
  return partial;
}

function normalizeVendorName(s) {
  return normalizeKeyword(s)
    .replace(/株式会社/g, "")
    .replace(/\(株\)/g, "")
    .replace(/有限会社/g, "")
    .replace(/\(有\)/g, "");
}

function normalizeReceiptToken(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[　]/g, "");
}

function normalizeReceiptVendor(s) {
  return normalizeReceiptToken(s)
    .replace(/株式会社/g, "")
    .replace(/\(株\)/g, "")
    .replace(/有限会社/g, "")
    .replace(/\(有\)/g, "");
}

function buildReceiptItemSet(items) {
  const set = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const n = normalizeReceiptToken(it?.name ?? "");
    if (n) set.add(n);
  }
  return set;
}

function receiptItemOverlapScore(aItems, bItems) {
  const a = buildReceiptItemSet(aItems);
  const b = buildReceiptItemSet(bItems);
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const x of a) {
    if (b.has(x)) hit += 1;
  }
  return hit / Math.max(a.size, b.size);
}

async function findLearnedReceiptCorrection(pool, userId, catWhere, summary, items) {
  const mk = receiptOcrMatchKey(summary, items ?? []);
  const [exactRows] = await pool.query(
    `SELECT category_id, memo FROM receipt_ocr_corrections
     WHERE user_id = ? AND match_key = ? LIMIT 1`,
    [userId, mk],
  );
  const exact = Array.isArray(exactRows) ? exactRows[0] : null;
  if (exact) {
    return {
      hit: true,
      categoryId:
        exact.category_id != null && exact.category_id !== ""
          ? Number(exact.category_id)
          : null,
      memoPresent: exact.memo != null,
      memoValue: exact.memo != null ? String(exact.memo).slice(0, 500) : "",
      mode: "exact",
    };
  }

  const vendorNorm = normalizeReceiptVendor(summary?.vendorName ?? "");
  if (!vendorNorm) {
    return { hit: false, categoryId: null, memoPresent: false, memoValue: "", mode: null };
  }
  const [candRows] = await pool.query(
    `SELECT category_id, memo, ocr_snapshot_json
     FROM receipt_ocr_corrections
     WHERE user_id = ?
       AND (category_id IS NOT NULL OR memo IS NOT NULL)
     ORDER BY updated_at DESC
     LIMIT 200`,
    [userId],
  );
  if (!Array.isArray(candRows) || candRows.length === 0) {
    return { hit: false, categoryId: null, memoPresent: false, memoValue: "", mode: null };
  }
  let best = null;
  for (const row of candRows) {
    let snap = null;
    try {
      snap = JSON.parse(String(row.ocr_snapshot_json ?? "{}"));
    } catch {
      continue;
    }
    const sv = normalizeReceiptVendor(snap?.vendorName ?? "");
    if (!sv) continue;
    const vendorMatched = sv === vendorNorm || sv.includes(vendorNorm) || vendorNorm.includes(sv);
    if (!vendorMatched) continue;
    const overlap = receiptItemOverlapScore(items ?? [], snap?.items ?? []);
    const score = 10 + overlap * 5;
    if (!best || score > best.score) {
      best = { row, score };
    }
  }
  if (!best || best.score < 10.5) {
    return { hit: false, categoryId: null, memoPresent: false, memoValue: "", mode: null };
  }
  return {
    hit: true,
    categoryId:
      best.row.category_id != null && best.row.category_id !== ""
        ? Number(best.row.category_id)
        : null,
    memoPresent: best.row.memo != null,
    memoValue: best.row.memo != null ? String(best.row.memo).slice(0, 500) : "",
    mode: "vendor_fallback",
  };
}

function tagFromCategoryName(name) {
  const n = normalizeKeyword(name);
  for (const [tag, aliases] of Object.entries(RECEIPT_CATEGORY_ALIASES)) {
    if (aliases.some((a) => n.includes(normalizeKeyword(a)))) return tag;
  }
  return null;
}

async function suggestExpenseCategoryFromHistory(pool, userId, txWhere, vendor) {
  const memo = String(vendor ?? "").trim();
  if (!memo) return null;
  const normMemo = normalizeVendorName(memo);
  if (!normMemo) return null;

  const normalizedMemoExpr =
    "LOWER(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(t.memo), ' ', ''), '　', ''), '株式会社', ''), '(株)', ''))";

  // まずは正規化完全一致で履歴学習カテゴリを選ぶ
  const [rows] = await pool.query(
    `SELECT t.category_id, c.name, COUNT(*) AS used_count
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE ${txWhere}
       AND t.kind = 'expense'
       AND t.category_id IS NOT NULL
       AND c.kind = 'expense'
       AND c.is_archived = 0
       AND ${normalizedMemoExpr} = ?
     GROUP BY t.category_id, c.name
     ORDER BY used_count DESC, t.category_id ASC
     LIMIT 1`,
    [userId, userId, normMemo],
  );
  if (Array.isArray(rows) && rows.length > 0) {
    const top = rows[0];
    return {
      id: Number(top.category_id),
      name: String(top.name),
      source: "history",
    };
  }

  // 次に包含一致（「イオン」「イオンスタイル」など）で緩く推定
  const [fuzzyRows] = await pool.query(
    `SELECT t.category_id, c.name, COUNT(*) AS used_count
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE ${txWhere}
       AND t.kind = 'expense'
       AND t.category_id IS NOT NULL
       AND c.kind = 'expense'
       AND c.is_archived = 0
       AND (
         INSTR(${normalizedMemoExpr}, ?) > 0
         OR INSTR(?, ${normalizedMemoExpr}) > 0
       )
     GROUP BY t.category_id, c.name
     ORDER BY used_count DESC, t.category_id ASC
     LIMIT 1`,
    [userId, userId, normMemo, normMemo],
  );
  if (!Array.isArray(fuzzyRows) || fuzzyRows.length === 0) return null;
  const top = fuzzyRows[0];
  return {
    id: Number(top.category_id),
    name: String(top.name),
    source: "history",
  };
}

async function suggestExpenseCategoryForReceipt(pool, userId, catWhere, txWhere, vendor, items) {
  const fromHistory = await suggestExpenseCategoryFromHistory(pool, userId, txWhere, vendor);
  if (fromHistory?.id) return fromHistory;

  const vend = normalizeKeyword(vendor ?? "");
  const itemCorpus = normalizeKeyword((items ?? []).map((x) => x?.name ?? "").join(" "));
  if (!vend && !itemCorpus) return null;
  const [rows] = await pool.query(
    `SELECT c.id, c.name
     FROM categories c
     WHERE ${catWhere} AND c.is_archived = 0 AND c.kind = 'expense'
     ORDER BY c.sort_order, c.id`,
    [userId, userId],
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const tagScore = {};
  for (const [tag, words] of Object.entries(RECEIPT_CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const w of words) {
      const nw = normalizeKeyword(w);
      if (!nw) continue;
      if (itemCorpus.includes(nw)) score += 3;
      if (vend.includes(nw)) score += 1;
    }
    if (score > 0) tagScore[tag] = (tagScore[tag] ?? 0) + score;
  }
  for (const [tag, words] of Object.entries(RECEIPT_VENDOR_TAG_HINTS)) {
    for (const w of words) {
      const nw = normalizeKeyword(w);
      if (nw && vend.includes(nw)) {
        tagScore[tag] = (tagScore[tag] ?? 0) + 4;
      }
    }
  }

  let best = null;
  for (const r of rows) {
    const tag = tagFromCategoryName(r.name);
    const score = tag ? (tagScore[tag] ?? 0) : 0;
    if (!best || score > best.score) {
      best = { id: Number(r.id), name: String(r.name), score };
    }
  }
  if (!best || best.score <= 0) return null;
  return { id: best.id, name: best.name, source: "keywords" };
}

function isUnknownIsPremiumColumnError(e) {
  if (!e || typeof e !== "object") return false;
  const code = e.code ? String(e.code) : "";
  const errno = Number(e.errno);
  const msg = String(e.message || "");
  return (
    (code === "ER_BAD_FIELD_ERROR" || errno === 1054) &&
    msg.includes("is_premium")
  );
}

function isUnknownSubscriptionColumnError(e) {
  if (!e || typeof e !== "object") return false;
  const code = e.code ? String(e.code) : "";
  const errno = Number(e.errno);
  const msg = String(e.message || "");
  const okCode = code === "ER_BAD_FIELD_ERROR" || errno === 1054;
  if (!okCode) return false;
  // エラーメッセージに SQL 断片だけが載る環境での誤検知を避ける（本当の Unknown column のみ）
  if (!/unknown column/i.test(msg)) return false;
  return msg.includes("subscription_status");
}

let warnedAdminUsersListSubscriptionColumnMissing = false;

const ADMIN_USERS_LIST_SQL_WITH_SUB = `SELECT
           u.id,
           u.email,
           u.login_name,
           u.display_name,
           u.is_admin,
           u.subscription_status,
           u.created_at,
           u.updated_at,
           u.last_login_at,
           u.default_family_id,
           (
             SELECT GROUP_CONCAT(
               CONCAT(
                 COALESCE(NULLIF(TRIM(u2.display_name), ''), u2.email),
                 ' (', fm2.role, ')'
               )
               ORDER BY fm2.id
               SEPARATOR ' / '
             )
             FROM family_members fm2
             JOIN users u2 ON u2.id = fm2.user_id
             WHERE u.default_family_id IS NOT NULL
               AND fm2.family_id = u.default_family_id
           ) AS family_peers
         FROM users u
         LEFT JOIN families f ON f.id = u.default_family_id
         ORDER BY u.id ASC
         LIMIT 1000`;

const ADMIN_USERS_LIST_SQL_WITHOUT_SUB = `SELECT
           u.id,
           u.email,
           u.login_name,
           u.display_name,
           u.is_admin,
           u.created_at,
           u.updated_at,
           u.last_login_at,
           u.default_family_id,
           (
             SELECT GROUP_CONCAT(
               CONCAT(
                 COALESCE(NULLIF(TRIM(u2.display_name), ''), u2.email),
                 ' (', fm2.role, ')'
               )
               ORDER BY fm2.id
               SEPARATOR ' / '
             )
             FROM family_members fm2
             JOIN users u2 ON u2.id = fm2.user_id
             WHERE u.default_family_id IS NOT NULL
               AND fm2.family_id = u.default_family_id
           ) AS family_peers
         FROM users u
         LEFT JOIN families f ON f.id = u.default_family_id
         ORDER BY u.id ASC
         LIMIT 1000`;

/**
 * migration v8 未適用時は subscription_status なしで一覧取得する。
 * meta.subscriptionStatusWritable は「本当にフォールバック SQL に落ちたか」で決める。
 * （mysql2 の RowDataPacket は hasOwnProperty で列が見えないことがあり、行のキー検査は信頼できない）
 * @returns {Promise<{ rows: unknown[]; usedSubscriptionFallback: boolean }>}
 */
async function queryAdminUsersListRows(pool) {
  try {
    const [rows] = await pool.query(ADMIN_USERS_LIST_SQL_WITH_SUB);
    return {
      rows: Array.isArray(rows) ? rows : [],
      usedSubscriptionFallback: false,
    };
  } catch (e) {
    if (isUnknownSubscriptionColumnError(e)) {
      if (!warnedAdminUsersListSubscriptionColumnMissing) {
        warnedAdminUsersListSubscriptionColumnMissing = true;
        logger.warn(
          "admin.users: subscription_status column missing; listing without it (apply db/migration_v8_users_subscription_status.sql)",
          { event: "admin.users.subscription_column_missing" },
        );
      }
      const [rows] = await pool.query(ADMIN_USERS_LIST_SQL_WITHOUT_SUB);
      return {
        rows: Array.isArray(rows) ? rows : [],
        usedSubscriptionFallback: true,
      };
    }
    throw e;
  }
}

async function loadUserSubscriptionRowFull(pool, userId) {
  try {
    const [rows] = await pool.query(
      `SELECT subscription_status, is_premium FROM users WHERE id = ? LIMIT 1`,
      [userId],
    );
    if (!Array.isArray(rows) || rows.length === 0) return {};
    return rows[0];
  } catch (e) {
    if (isUnknownIsPremiumColumnError(e)) {
      try {
        const [rows] = await pool.query(
          `SELECT subscription_status FROM users WHERE id = ? LIMIT 1`,
          [userId],
        );
        if (!Array.isArray(rows) || rows.length === 0) return {};
        return rows[0];
      } catch (e2) {
        if (isUnknownSubscriptionColumnError(e2)) {
          logger.warn("subscription_status column missing; defaulting to inactive", {
            userId,
          });
          return {};
        }
        throw e2;
      }
    }
    if (isUnknownSubscriptionColumnError(e)) {
      logger.warn("subscription_status column missing; defaulting to inactive", {
        userId,
      });
      return {};
    }
    throw e;
  }
}

async function loadUserSubscriptionStatus(pool, userId) {
  const row = await loadUserSubscriptionRowFull(pool, userId);
  const derived = deriveSubscriptionStatusFromDbRow(row);
  return getEffectiveSubscriptionStatus(derived, userId);
}

/**
 * サブスク有料レシートAI向け: 家族スコープの最近の支出メモをヒントに渡す。
 */
async function fetchReceiptSubscriptionHistoryHints(pool, userId, txWhere, limit = 48) {
  const lim = Math.min(80, Math.max(8, Number(limit) || 48));
  const [rows] = await pool.query(
    `SELECT t.transaction_date AS d, t.memo, t.amount, c.name AS category_name
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE ${txWhere}
       AND t.kind = 'expense'
       AND TRIM(COALESCE(t.memo, '')) <> ''
     ORDER BY t.transaction_date DESC, t.id DESC
     LIMIT ?`,
    [userId, userId, lim],
  );
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    date: r.d ? String(r.d).slice(0, 10) : "",
    memo: r.memo != null ? String(r.memo).trim().slice(0, 200) : "",
    amount: r.amount != null ? String(r.amount) : "",
    categoryName:
      r.category_name != null ? String(r.category_name).trim().slice(0, 100) : null,
  }));
}

function tokenizeMemo(text) {
  const s = normalizeKeyword(text);
  if (!s) return [];
  const chunks = s
    .split(/[\/・,，\-_()\[\]【】]/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (chunks.length > 0) return chunks;
  return [s];
}

async function suggestExpenseCategoryForMemo(pool, userId, catWhere, txWhere, memo) {
  const vendor = String(memo ?? "").trim();
  if (!vendor) return null;
  const fromHistory = await suggestExpenseCategoryFromHistory(pool, userId, txWhere, vendor);
  if (fromHistory?.id) return fromHistory;
  const tokens = tokenizeMemo(vendor).map((name) => ({ name, amount: null }));
  return suggestExpenseCategoryForReceipt(pool, userId, catWhere, txWhere, vendor, tokens);
}

/**
 * 同一種別・正規化名の既存カテゴリ ID（あれば）。excludeId は PATCH 時に自分自身を除く。
 */
async function findDuplicateCategoryId(pool, userId, catWhere, kind, rawName, excludeId) {
  const nm = String(rawName ?? "").trim();
  if (!nm) return null;
  const want = normalizeCategoryNameKey(nm);
  const [rows] = await pool.query(
    `SELECT c.id, c.name FROM categories c
     WHERE ${catWhere} AND c.is_archived = 0 AND c.kind = ?`,
    [userId, userId, kind],
  );
  for (const r of rows || []) {
    const id = Number(r.id);
    if (excludeId != null && id === Number(excludeId)) continue;
    if (normalizeCategoryNameKey(r.name) === want) return id;
  }
  return null;
}

/**
 * CSV 取込用: 支出カテゴリを名前で検索し、無ければ作成する。
 * idByNormKey: 同一リクエスト内の正規化名 → id キャッシュ（省略可）
 * @returns {{ categoryId: number | null, created: boolean }}
 */
async function findOrCreateExpenseCategoryByName(
  pool,
  userId,
  familyId,
  catWhere,
  rawName,
  idByNormKey = null,
) {
  const name = String(rawName ?? "").trim();
  if (!name) return { categoryId: null, created: false };
  const safeName = name.length <= 100 ? name : name.slice(0, 100);
  const normKey = normalizeCategoryNameKey(safeName);
  if (idByNormKey?.has(normKey)) {
    return { categoryId: idByNormKey.get(normKey), created: false };
  }
  const dup = await findDuplicateCategoryId(
    pool,
    userId,
    catWhere,
    "expense",
    safeName,
    null,
  );
  if (dup != null) {
    idByNormKey?.set(normKey, dup);
    return { categoryId: dup, created: false };
  }
  const paramsBase = [userId, userId];
  const [[mx]] = await pool.query(
    `SELECT COALESCE(MAX(c.sort_order), 0) AS m FROM categories c
     WHERE ${catWhere} AND c.is_archived = 0 AND c.kind = 'expense'`,
    paramsBase,
  );
  const sortOrder = Number(mx?.m ?? 0) + 10;
  const [ins] = await pool.query(
    `INSERT INTO categories (user_id, family_id, parent_id, name, kind, color_hex, sort_order)
     VALUES (?, ?, NULL, ?, 'expense', NULL, ?)`,
    [userId, familyId, safeName, sortOrder],
  );
  const newId = Number(ins.insertId);
  idByNormKey?.set(normKey, newId);
  return { categoryId: newId, created: true };
}

function ymBounds(yearMonth) {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth || "");
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const from = `${y}-${String(mo).padStart(2, "0")}-01`;
  const last = new Date(y, mo, 0).getDate();
  const to = `${y}-${String(mo).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { from, to };
}

async function ensureAdmin(pool, userId) {
  const [rows] = await pool.query(
    `SELECT id, email, is_admin FROM users WHERE id = ? LIMIT 1`,
    [userId],
  );
  const user = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  if (!user) return { ok: false, status: 401, body: { error: "認証ユーザーが見つかりません" } };
  const email = String(user.email || "").toLowerCase();
  const superAdmin = email === "script_00123@yahoo.co.jp";
  if (Number(user.is_admin) !== 1 && !superAdmin) {
    return { ok: false, status: 403, body: { error: "管理者権限が必要です" } };
  }
  return { ok: true };
}

function generateAdminTempPassword() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 12; i += 1) {
    out += chars[crypto.randomInt(chars.length)];
  }
  return out;
}

/**
 * @param {{ method: string, path: string, queryStringParameters?: Record<string,string>|null, body?: string|null, headers?: Record<string, string> }} req
 * @param {{ skipCors?: boolean }} [options]
 */
export async function handleApiRequest(req, options = {}) {
  const { skipCors = false } = options;
  const method = req.method.toUpperCase();
  const path = stripApiPathPrefix(req.path.split("?")[0] || "/");
  const hdrs = req.headers;

  if (method === "OPTIONS") {
    const cors = skipCors ? {} : buildCorsHeaders(hdrs);
    return { statusCode: 204, headers: { ...cors }, body: "" };
  }

  try {
    const authRes = await tryAuthRoutes(req, {
      json,
      hdrs,
      skipCors,
    });
    if (authRes) return authRes;

    if (routeKey(method, path) === "GET /") {
      return json(
        200,
        {
          service: "kakeibo-api",
          message:
            "API は稼働中です。認証: POST /auth/login（JWT）。ヘルス: GET /health",
          endpoints: {
            health: "/health",
            auth: "/auth/login",
            transactions: "/transactions",
            summary: "/summary/month",
            fixedCosts: "/settings/fixed-costs",
          },
        },
        hdrs,
        skipCors,
      );
    }

    {
      const rk = routeKey(method, path);
      const healthGetOrHead = rk === "GET /health" || rk === "HEAD /health";
      if (healthGetOrHead) {
        const rdsHost = String(process.env.RDS_HOST || "").trim();
        if (!rdsHost) {
          if (method === "HEAD") {
            const cors = skipCors ? {} : buildCorsHeaders(hdrs);
            return { statusCode: 503, headers: { ...cors }, body: "" };
          }
          return json(
            503,
            {
              error: "DatabaseNotConfigured",
              detail:
                "データベース（RDS）に接続されていません。家計簿 API には MySQL の設定が必要です。",
            },
            hdrs,
            skipCors,
          );
        }
        try {
          await pingDatabase();
          if (method === "HEAD") {
            const cors = skipCors ? {} : buildCorsHeaders(hdrs);
            return { statusCode: 200, headers: { ...cors }, body: "" };
          }
          return json(200, { ok: true, database: "up" }, hdrs, skipCors);
        } catch (e) {
          logError("health.db", e, { method, path });
          const o = e && typeof e === "object" ? e : {};
          const code =
            o.code ?? (o.errno != null ? `errno_${o.errno}` : "UNKNOWN");
          const sqlMessage =
            typeof o.sqlMessage === "string" ? o.sqlMessage : undefined;
          const verbose =
            process.env.NODE_ENV === "development" ||
            process.env.HEALTH_VERBOSE === "true";
          if (method === "HEAD") {
            const cors = skipCors ? {} : buildCorsHeaders(hdrs);
            return { statusCode: 503, headers: { ...cors }, body: "" };
          }
          return json(
            503,
            {
              ok: false,
              error: "DatabaseUnavailable",
              code: String(code),
              ...(sqlMessage ? { sqlMessage } : {}),
              hint:
                "RDS の環境変数・VPC コネクタ・セキュリティグループを確認してください。",
              ...(verbose && e instanceof Error ? { message: e.message } : {}),
            },
            hdrs,
            skipCors,
          );
        }
      }
    }

    if (!isRdsConfigured()) {
      return json(
        503,
        {
          error: "DatabaseNotConfigured",
          detail:
            "データベース（RDS）に接続されていません。家計簿 API には MySQL の設定が必要です。",
        },
        hdrs,
        skipCors,
      );
    }

    const pool = getPool();

    const userId = resolveUserId(hdrs);
    if (!userId) {
      return json(
        401,
        {
          error: "認証されていません",
          detail: "Authorization: Bearer <JWT> が必要です（開発時のみ ALLOW_X_USER_ID=true で X-User-Id 可）",
        },
        hdrs,
        skipCors,
      );
    }

    const q = req.queryStringParameters || {};
    const familyId = await getDefaultFamilyId(pool, userId);

    const catWhere = `(c.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?) OR (c.family_id IS NULL AND c.user_id = ?))`;
    const txWhere = `(t.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?) OR (t.family_id IS NULL AND t.user_id = ?))`;
    const txWhereFamily = `(t.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?))`;

    const normPath = path.replace(/\/$/, "") || "/";
    const txOneMatch = /^\/transactions\/(\d+)$/.exec(normPath);
    const categoryOneMatch = /^\/categories\/(\d+)$/.exec(normPath);
    const adminUserOneMatch = /^\/admin\/users\/(\d+)$/.exec(normPath);
    const adminUserResetPasswordMatch = /^\/admin\/users\/(\d+)\/reset-password$/.exec(normPath);

    if (txOneMatch && method === "PATCH") {
      const txId = Number(txOneMatch[1], 10);
      const b = JSON.parse(req.body || "{}");
      const txPatchSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
      if (txPatchSubRej) return txPatchSubRej;
      const [[existing]] = await pool.query(
        `SELECT id, user_id, family_id, kind, amount, transaction_date, memo, category_id
         FROM transactions t WHERE t.id = ? AND (${txWhere})`,
        [txId, userId, userId],
      );
      if (!existing) {
        return json(404, { error: "見つかりません" }, hdrs, skipCors);
      }
      const nextKind =
        b.kind === "income" || b.kind === "expense"
          ? b.kind
          : String(existing.kind || "expense");
      const nextAmount =
        b.amount != null && b.amount !== ""
          ? Number(b.amount)
          : Number(existing.amount);
      const nextDate =
        b.transaction_date != null && b.transaction_date !== ""
          ? String(b.transaction_date).slice(0, 10)
          : String(existing.transaction_date ?? "").slice(0, 10);
      const nextMemo = Object.prototype.hasOwnProperty.call(b, "memo")
        ? normalizeTxMemo(b.memo)
        : normalizeTxMemo(existing.memo);
      let nextCategoryId = existing.category_id;
      if (Object.prototype.hasOwnProperty.call(b, "category_id")) {
        if (b.category_id == null || b.category_id === "") {
          nextCategoryId = null;
        } else {
          const cid = Number(b.category_id);
          if (!Number.isFinite(cid)) {
            return json(400, { error: "category_id が不正です" }, hdrs, skipCors);
          }
          nextCategoryId = cid;
        }
      }
      const nextAmountValidation = validateTransactionAmount(nextKind, nextAmount);
      if (!nextAmountValidation.ok) {
        return json(400, { error: nextAmountValidation.error }, hdrs, skipCors);
      }
      const fields = [];
      const params = [];
      if (b.kind === "income" || b.kind === "expense") {
        fields.push("kind = ?");
        params.push(b.kind);
      }
      if (b.amount != null && b.amount !== "") {
        fields.push("amount = ?");
        params.push(nextAmount);
      }
      if (b.transaction_date != null && b.transaction_date !== "") {
        fields.push("transaction_date = ?");
        params.push(nextDate);
      }
      if (Object.prototype.hasOwnProperty.call(b, "memo")) {
        fields.push("memo = ?");
        params.push(nextMemo);
      }
      if (Object.prototype.hasOwnProperty.call(b, "category_id")) {
        fields.push("category_id = ?");
        params.push(nextCategoryId);
      }
      if (fields.length === 0) {
        return json(400, { error: "更新項目がありません" }, hdrs, skipCors);
      }
      const [dupRows] = await pool.query(
        `SELECT t.id, t.amount
         FROM transactions t
         WHERE t.user_id = ?
           AND t.id <> ?
           AND t.kind = ?
           AND t.transaction_date = ?
           AND (t.category_id <=> ?)
           AND (t.memo <=> ?)
         ORDER BY t.id DESC
         LIMIT 1`,
        [userId, txId, nextKind, nextDate, nextCategoryId, nextMemo],
      );
      const dup = Array.isArray(dupRows) && dupRows.length > 0 ? dupRows[0] : null;
      if (dup) {
        const mergedAmount = Number(dup.amount ?? 0) + Number(nextAmount ?? 0);
        const mergedValidation = validateTransactionAmount(nextKind, mergedAmount);
        if (!mergedValidation.ok) {
          return json(400, { error: mergedValidation.error }, hdrs, skipCors);
        }
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          await conn.query(
            `UPDATE transactions
             SET amount = ?, updated_at = NOW()
             WHERE id = ? AND user_id = ?`,
            [mergedAmount, dup.id, userId],
          );
          await conn.query(
            `DELETE FROM transactions
             WHERE id = ? AND user_id = ?`,
            [txId, userId],
          );
          await conn.commit();
        } catch (e) {
          await conn.rollback();
          throw e;
        } finally {
          conn.release();
        }
        return json(
          200,
          { ok: true, merged: true, mergedIntoId: Number(dup.id), deletedId: txId },
          hdrs,
          skipCors,
        );
      }
      params.push(txId);
      await pool.query(
        `UPDATE transactions t SET ${fields.join(", ")} WHERE t.id = ? AND (${txWhere})`,
        [...params, userId, userId],
      );
      return json(200, { ok: true }, hdrs, skipCors);
    }

    if (txOneMatch && method === "DELETE") {
      const txId = Number(txOneMatch[1], 10);
      const [delRes] = await pool.query(
        `DELETE t FROM transactions t WHERE t.id = ? AND (${txWhere})`,
        [txId, userId, userId],
      );
      if (!delRes.affectedRows) {
        return json(404, { error: "見つかりません" }, hdrs, skipCors);
      }
      return json(200, { ok: true }, hdrs, skipCors);
    }

    if (routeKey(method, path) === "GET /admin/users") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const { rows, usedSubscriptionFallback } = await queryAdminUsersListRows(pool);
      const subscriptionStatusWritable = !usedSubscriptionFallback;
      const items = rows.map((r) => ({
        id: Number(r.id),
        email: String(r.email ?? ""),
        login_name: r.login_name == null ? null : String(r.login_name),
        display_name: r.display_name == null ? null : String(r.display_name),
        isAdmin: Number(r.is_admin) === 1,
        subscriptionStatus:
          r.subscription_status != null && String(r.subscription_status).trim() !== ""
            ? String(r.subscription_status).trim()
            : "inactive",
        created_at: r.created_at ?? null,
        updated_at: r.updated_at ?? null,
        last_login_at: r.last_login_at ?? null,
        default_family_id: r.default_family_id ?? null,
        family_peers: r.family_peers == null || r.family_peers === "" ? null : String(r.family_peers),
      }));
      return json(
        200,
        {
          items,
          meta: { subscriptionStatusWritable },
        },
        hdrs,
        skipCors,
      );
    }

    if (routeKey(method, path) === "POST /admin/users") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const b = JSON.parse(req.body || "{}");
      const email = String(b.email ?? "").trim().toLowerCase();
      const loginRaw = b.login_name != null ? String(b.login_name).trim() : "";
      const loginName = loginRaw.length > 0 ? loginRaw : null;
      const password = String(b.password ?? "");
      const displayRaw = b.display_name != null ? String(b.display_name).trim() : "";
      const displayName = displayRaw.length > 0 ? displayRaw : null;
      const isAdmin = b.isAdmin === true;

      if (!email || !email.includes("@")) {
        return json(400, { error: "メールアドレスが不正です" }, hdrs, skipCors);
      }
      if (!/^[a-zA-Z0-9]{8,}$/.test(password)) {
        return json(400, { error: "パスワードは英数字8文字以上にしてください" }, hdrs, skipCors);
      }
      if (loginName && !/^[a-zA-Z0-9]{1,15}$/.test(loginName)) {
        return json(400, { error: "ログインIDは英数字のみ・最大15文字で入力してください" }, hdrs, skipCors);
      }
      if (displayName && (!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]+$/u.test(displayName) || displayName.length > 10)) {
        return json(400, { error: "表示名は漢字・カナ・英数字のみ、最大10文字で入力してください" }, hdrs, skipCors);
      }

      const passwordHash = await hashPassword(password);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [emailDup] = await conn.query(
          `SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1`,
          [email],
        );
        if (emailDup.length > 0) {
          await conn.rollback();
          return json(409, { error: "このメールアドレスは既に登録されています。別のメールアドレスを入力してください。" }, hdrs, skipCors);
        }
        if (loginName) {
          const loginLc = loginName.toLowerCase();
          const [loginDup] = await conn.query(
            `SELECT id FROM users WHERE LOWER(email) = ? OR (login_name IS NOT NULL AND LOWER(login_name) = ?) LIMIT 1`,
            [loginLc, loginLc],
          );
          if (loginDup.length > 0) {
            await conn.rollback();
            return json(409, { error: "このログインIDは既に使用されています（他の方のメールアドレスと同じ文字列も使えません）。別のログインIDを入力してください。" }, hdrs, skipCors);
          }
        }
        if (displayName) {
          const [dispDup] = await conn.query(
            `SELECT id FROM users WHERE display_name IS NOT NULL AND TRIM(display_name) <> '' AND LOWER(TRIM(display_name)) = LOWER(?) LIMIT 1`,
            [displayName],
          );
          if (dispDup.length > 0) {
            await conn.rollback();
            return json(409, { error: "この表示名は既に使われています。別の表示名を入力してください。" }, hdrs, skipCors);
          }
        }

        const [ur] = await conn.query(
          `INSERT INTO users (email, login_name, password_hash, display_name, is_admin)
           VALUES (?, ?, ?, ?, ?)`,
          [email, loginName, passwordHash, displayName, isAdmin ? 1 : 0],
        );
        const newUserId = Number(ur.insertId);
        const [fr] = await conn.query(`INSERT INTO families (name) VALUES (?)`, ["夫婦"]);
        const familyId = Number(fr.insertId);
        await conn.query(`UPDATE users SET default_family_id = ? WHERE id = ?`, [familyId, newUserId]);
        await conn.query(
          `INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, ?)`,
          [familyId, newUserId, "owner"],
        );
        await conn.commit();

        await seedDefaultCategoriesIfEmpty(pool, newUserId, familyId);
        return json(201, { ok: true, id: newUserId }, hdrs, skipCors);
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    }

    if (adminUserOneMatch && method === "PATCH") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const targetUserId = Number(adminUserOneMatch[1], 10);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return json(400, { error: "ユーザーIDが不正です" }, hdrs, skipCors);
      }
      const b = JSON.parse(req.body || "{}");
      const updates = [];
      const params = [];

      if (Object.prototype.hasOwnProperty.call(b, "isAdmin")) {
        if (typeof b.isAdmin !== "boolean") {
          return json(400, { error: "isAdmin は boolean で指定してください" }, hdrs, skipCors);
        }
        updates.push("is_admin = ?");
        params.push(b.isAdmin ? 1 : 0);
      }
      if (Object.prototype.hasOwnProperty.call(b, "displayName")) {
        const rawName = b.displayName == null ? "" : String(b.displayName).trim();
        if (rawName.length > 100) {
          return json(400, { error: "displayName は100文字以内で指定してください" }, hdrs, skipCors);
        }
        const normalized = rawName === "" ? null : rawName;
        if (normalized != null) {
          const [dupRows] = await pool.query(
            `SELECT id FROM users WHERE display_name IS NOT NULL AND TRIM(display_name) <> '' AND LOWER(TRIM(display_name)) = LOWER(?) AND id <> ? LIMIT 1`,
            [normalized, targetUserId],
          );
          if (dupRows.length > 0) {
            return json(
              409,
              {
                error:
                  "この表示名は既に使われています。別の表示名を入力してください。",
              },
              hdrs,
              skipCors,
            );
          }
        }
        updates.push("display_name = ?");
        params.push(normalized);
      }
      if (Object.prototype.hasOwnProperty.call(b, "subscriptionStatus")) {
        const normalizedSub = normalizeAdminSettableSubscriptionStatus(b.subscriptionStatus);
        if (normalizedSub == null) {
          return json(
            400,
            {
              error:
                "subscriptionStatus は inactive / active / past_due / canceled / trialing のいずれかで指定してください",
            },
            hdrs,
            skipCors,
          );
        }
        updates.push("subscription_status = ?");
        params.push(normalizedSub);
      }
      if (updates.length === 0) {
        return json(400, { error: "更新項目がありません" }, hdrs, skipCors);
      }
      const [[exists]] = await pool.query(
        `SELECT id, is_admin FROM users WHERE id = ?`,
        [targetUserId],
      );
      if (!exists) {
        return json(404, { error: "対象ユーザーが見つかりません" }, hdrs, skipCors);
      }
      if (
        Object.prototype.hasOwnProperty.call(b, "isAdmin") &&
        b.isAdmin === false &&
        Number(exists.is_admin) === 1
      ) {
        const [[cntRow]] = await pool.query(
          `SELECT COUNT(*) AS c FROM users WHERE is_admin = 1`,
        );
        if (Number(cntRow?.c) <= 1) {
          return json(400, { error: "最後の管理者の権限は外せません" }, hdrs, skipCors);
        }
      }
      try {
        await pool.query(
          `UPDATE users SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ?`,
          [...params, targetUserId],
        );
      } catch (e) {
        if (isUnknownSubscriptionColumnError(e)) {
          return json(
            503,
            {
              error: "SubscriptionColumnMissing",
              detail:
                "users.subscription_status 列がありません。RDS に db/migration_v8_users_subscription_status.sql を適用してから、サブスク状態を変更してください。",
            },
            hdrs,
            skipCors,
          );
        }
        throw e;
      }
      return json(200, { ok: true }, hdrs, skipCors);
    }

    if (adminUserResetPasswordMatch && method === "POST") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const targetUserId = Number(adminUserResetPasswordMatch[1], 10);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return json(400, { error: "ユーザーIDが不正です" }, hdrs, skipCors);
      }
      const tempPassword = generateAdminTempPassword();
      const passwordHash = await hashPassword(tempPassword);
      const [upd] = await pool.query(
        `UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?`,
        [passwordHash, targetUserId],
      );
      if (!upd?.affectedRows) {
        return json(404, { error: "対象ユーザーが見つかりません" }, hdrs, skipCors);
      }
      await pool.query(
        `DELETE FROM password_reset_tokens WHERE user_id = ?`,
        [targetUserId],
      );
      return json(
        200,
        {
          ok: true,
          temporaryPassword: tempPassword,
          message: "一時パスワードを発行しました。ログイン後に変更してください。",
        },
        hdrs,
        skipCors,
      );
    }

    if (adminUserOneMatch && method === "DELETE") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const targetUserId = Number(adminUserOneMatch[1], 10);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return json(400, { error: "ユーザーIDが不正です" }, hdrs, skipCors);
      }
      if (targetUserId === userId) {
        return json(400, { error: "自分自身は削除できません" }, hdrs, skipCors);
      }
      const [[target]] = await pool.query(
        `SELECT id, is_admin FROM users WHERE id = ?`,
        [targetUserId],
      );
      if (!target) {
        return json(404, { error: "対象ユーザーが見つかりません" }, hdrs, skipCors);
      }
      if (Number(target.is_admin) === 1) {
        const [[cntRow]] = await pool.query(
          `SELECT COUNT(*) AS c FROM users WHERE is_admin = 1`,
        );
        if (Number(cntRow?.c) <= 1) {
          return json(400, { error: "最後の管理者は削除できません" }, hdrs, skipCors);
        }
      }
      const [del] = await pool.query(`DELETE FROM users WHERE id = ?`, [targetUserId]);
      if (!del?.affectedRows) {
        return json(404, { error: "対象ユーザーが見つかりません" }, hdrs, skipCors);
      }
      return json(200, { ok: true }, hdrs, skipCors);
    }

    if (categoryOneMatch && method === "PATCH") {
      const categoryId = Number(categoryOneMatch[1], 10);
      if (!Number.isFinite(categoryId) || categoryId <= 0) {
        return json(400, { error: "カテゴリIDが不正です" }, hdrs, skipCors);
      }
      const b = JSON.parse(req.body || "{}");
      const catPatchSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
      if (catPatchSubRej) return catPatchSubRej;
      const [[cur]] = await pool.query(
        `SELECT c.name, c.kind FROM categories c
         WHERE c.id = ? AND (${catWhere}) AND c.is_archived = 0 LIMIT 1`,
        [categoryId, userId, userId],
      );
      if (!cur) {
        return json(404, { error: "カテゴリが見つかりません" }, hdrs, skipCors);
      }
      const fields = [];
      const params = [];
      if (Object.prototype.hasOwnProperty.call(b, "name")) {
        const raw = b.name == null ? "" : String(b.name).trim();
        if (raw.length < 1 || raw.length > 100) {
          return json(400, { error: "name は1〜100文字で指定してください" }, hdrs, skipCors);
        }
        fields.push("name = ?");
        params.push(raw);
      }
      if (Object.prototype.hasOwnProperty.call(b, "kind")) {
        if (b.kind !== "expense" && b.kind !== "income") {
          return json(400, { error: "kind は expense または income です" }, hdrs, skipCors);
        }
        fields.push("kind = ?");
        params.push(b.kind);
      }
      if (Object.prototype.hasOwnProperty.call(b, "color_hex")) {
        const ch = b.color_hex == null || b.color_hex === "" ? null : String(b.color_hex).trim();
        if (ch != null && !/^#[0-9A-Fa-f]{6}$/.test(ch)) {
          return json(400, { error: "color_hex は #RRGGBB 形式で指定してください" }, hdrs, skipCors);
        }
        fields.push("color_hex = ?");
        params.push(ch);
      }
      if (Object.prototype.hasOwnProperty.call(b, "sort_order")) {
        const so = Number(b.sort_order);
        if (!Number.isFinite(so)) {
          return json(400, { error: "sort_order が不正です" }, hdrs, skipCors);
        }
        fields.push("sort_order = ?");
        params.push(so);
      }
      if (Object.prototype.hasOwnProperty.call(b, "is_archived")) {
        if (typeof b.is_archived !== "boolean") {
          return json(400, { error: "is_archived は boolean で指定してください" }, hdrs, skipCors);
        }
        fields.push("is_archived = ?");
        params.push(b.is_archived ? 1 : 0);
      }
      if (fields.length === 0) {
        return json(400, { error: "更新項目がありません" }, hdrs, skipCors);
      }
      const nextName = Object.prototype.hasOwnProperty.call(b, "name")
        ? String(b.name).trim()
        : String(cur.name ?? "");
      const nextKind =
        Object.prototype.hasOwnProperty.call(b, "kind") &&
        (b.kind === "expense" || b.kind === "income")
          ? b.kind
          : String(cur.kind ?? "expense");
      if (
        Object.prototype.hasOwnProperty.call(b, "name") ||
        Object.prototype.hasOwnProperty.call(b, "kind")
      ) {
        const dupId = await findDuplicateCategoryId(
          pool,
          userId,
          catWhere,
          nextKind,
          nextName,
          categoryId,
        );
        if (dupId != null) {
          return json(
            409,
            {
              error: "同じ名前のカテゴリが既にあります",
              existing_id: dupId,
            },
            hdrs,
            skipCors,
          );
        }
      }
      const [upd] = await pool.query(
        `UPDATE categories c SET ${fields.join(", ")}, updated_at = NOW()
         WHERE c.id = ? AND (${catWhere})`,
        [...params, categoryId, userId, userId],
      );
      if (!upd?.affectedRows) {
        return json(404, { error: "カテゴリが見つかりません" }, hdrs, skipCors);
      }
      return json(200, { ok: true }, hdrs, skipCors);
    }

    if (categoryOneMatch && method === "DELETE") {
      const categoryId = Number(categoryOneMatch[1], 10);
      if (!Number.isFinite(categoryId) || categoryId <= 0) {
        return json(400, { error: "カテゴリIDが不正です" }, hdrs, skipCors);
      }
      const [upd] = await pool.query(
        `UPDATE categories c SET is_archived = 1, updated_at = NOW()
         WHERE c.id = ? AND (${catWhere}) AND c.is_archived = 0`,
        [categoryId, userId, userId],
      );
      if (!upd?.affectedRows) {
        return json(404, { error: "カテゴリが見つかりません" }, hdrs, skipCors);
      }
      return json(200, { ok: true }, hdrs, skipCors);
    }

    switch (routeKey(method, path)) {
      case "GET /categories": {
        await seedDefaultCategoriesIfEmpty(pool, userId, familyId);
        try {
          await mergeDuplicateCategories(pool, userId, catWhere, txWhere);
        } catch (e) {
          logError("categories.merge_duplicates", e);
        }
        const [rows] = await pool.query(
          `SELECT c.id, c.parent_id, c.name, c.kind, c.color_hex, c.sort_order, c.is_archived, c.created_at, c.updated_at
           FROM categories c
           WHERE ${catWhere} AND c.is_archived = 0
           ORDER BY c.kind, c.sort_order, c.id`,
          [userId, userId],
        );
        return json(200, { items: rows }, hdrs, skipCors);
      }

      case "POST /categories/ensure-defaults": {
        const r = await seedDefaultCategoriesIfEmpty(pool, userId, familyId);
        return json(200, { ok: true, inserted: r.inserted }, hdrs, skipCors);
      }

      case "POST /categories": {
        const b = JSON.parse(req.body || "{}");
        const catSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (catSubRej) return catSubRej;
        const rawName = b.name == null ? "" : String(b.name).trim();
        if (rawName.length < 1 || rawName.length > 100) {
          return json(400, { error: "name は1〜100文字で指定してください" }, hdrs, skipCors);
        }
        const kind = b.kind === "income" ? "income" : "expense";
        const ch =
          b.color_hex == null || b.color_hex === ""
            ? null
            : String(b.color_hex).trim();
        if (ch != null && !/^#[0-9A-Fa-f]{6}$/.test(ch)) {
          return json(400, { error: "color_hex は #RRGGBB 形式で指定してください" }, hdrs, skipCors);
        }
        const so = b.sort_order != null ? Number(b.sort_order) : 0;
        if (!Number.isFinite(so)) {
          return json(400, { error: "sort_order が不正です" }, hdrs, skipCors);
        }
        const dupId = await findDuplicateCategoryId(
          pool,
          userId,
          catWhere,
          kind,
          rawName,
          null,
        );
        if (dupId != null) {
          return json(
            409,
            {
              error: "同じ名前のカテゴリが既にあります",
              existing_id: dupId,
            },
            hdrs,
            skipCors,
          );
        }
        const [r] = await pool.query(
          `INSERT INTO categories (user_id, family_id, parent_id, name, kind, color_hex, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            familyId,
            b.parent_id ?? null,
            rawName,
            kind,
            ch,
            so,
          ],
        );
        return json(201, { id: r.insertId }, hdrs, skipCors);
      }

      case "GET /transactions": {
        const from = q.from;
        const to = q.to;
        const familyScopeOnly = String(q.scope ?? "").toLowerCase() === "family";
        const txWhereForScope = familyScopeOnly ? txWhereFamily : txWhere;
        let sql = `SELECT t.id, t.account_id, t.category_id, t.kind, t.amount, t.transaction_date, t.memo, t.created_at, t.updated_at, t.user_id
                   FROM transactions t
                   WHERE ${txWhereForScope}`;
        const params = familyScopeOnly ? [userId] : [userId, userId];
        if (from) {
          sql += ` AND t.transaction_date >= ?`;
          params.push(from);
        }
        if (to) {
          sql += ` AND t.transaction_date <= ?`;
          params.push(to);
        }
        sql += ` ORDER BY t.transaction_date DESC, t.id DESC LIMIT 500`;
        const [rows] = await pool.query(sql, params);
        return json(200, { items: rows }, hdrs, skipCors);
      }

      case "POST /transactions": {
        const b = JSON.parse(req.body || "{}");
        const txSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (txSubRej) return txSubRej;
        const kind = b.kind === "income" ? "income" : "expense";
        const amt = Number(b.amount);
        const v = validateTransactionAmount(kind, amt);
        if (!v.ok) {
          return json(400, { error: v.error }, hdrs, skipCors);
        }
        const txDate = String(b.transaction_date ?? "").slice(0, 10);
        if (!txDate) {
          return json(400, { error: "transaction_date が必要です" }, hdrs, skipCors);
        }
        let categoryId = null;
        if (b.category_id != null && b.category_id !== "") {
          categoryId = Number(b.category_id);
          if (!Number.isFinite(categoryId)) {
            return json(400, { error: "category_id が不正です" }, hdrs, skipCors);
          }
        }
        const memo = normalizeTxMemo(b.memo);
        const fromReceipt = b.from_receipt === true || b.from_receipt === "true";
        if (fromReceipt) {
          const [exactRows] = await pool.query(
            `SELECT t.id FROM transactions t
             WHERE t.user_id = ?
               AND t.kind = ?
               AND t.transaction_date = ?
               AND t.amount = ?
               AND (t.memo <=> ?)
             LIMIT 1`,
            [userId, kind, txDate, amt, memo],
          );
          if (Array.isArray(exactRows) && exactRows.length > 0) {
            return json(
              409,
              {
                error: "AlreadyRegistered",
                detail: "既に登録済です",
              },
              hdrs,
              skipCors,
            );
          }
        }
        const [dupRows] = await pool.query(
          `SELECT t.id, t.amount
           FROM transactions t
           WHERE t.user_id = ?
             AND t.kind = ?
             AND t.transaction_date = ?
             AND (t.category_id <=> ?)
             AND (t.memo <=> ?)
           ORDER BY t.id DESC
           LIMIT 1`,
          [userId, kind, txDate, categoryId, memo],
        );
        const dup = Array.isArray(dupRows) && dupRows.length > 0 ? dupRows[0] : null;
        if (dup) {
          const mergedAmount = Number(dup.amount ?? 0) + Number(amt);
          const mergedValidation = validateTransactionAmount(kind, mergedAmount);
          if (!mergedValidation.ok) {
            return json(400, { error: mergedValidation.error }, hdrs, skipCors);
          }
          await pool.query(
            `UPDATE transactions
             SET amount = ?, updated_at = NOW()
             WHERE id = ? AND user_id = ?`,
            [mergedAmount, dup.id, userId],
          );
          return json(200, { id: Number(dup.id), merged: true }, hdrs, skipCors);
        }
        const [r] = await pool.query(
          `INSERT INTO transactions
           (user_id, family_id, account_id, category_id, kind, amount, transaction_date, memo, external_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            familyId,
            b.account_id ?? null,
            categoryId,
            kind,
            amt,
            txDate,
            memo,
            b.external_id ?? null,
          ],
        );
        return json(201, { id: r.insertId }, hdrs, skipCors);
      }

      case "POST /transactions/delete": {
        const b = JSON.parse(req.body || "{}");
        const txDelSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (txDelSubRej) return txDelSubRej;
        const txId = Number(b.id);
        if (!Number.isFinite(txId) || txId <= 0) {
          return json(400, { error: "id が不正です" }, hdrs, skipCors);
        }
        const [delRes] = await pool.query(
          `DELETE t FROM transactions t WHERE t.id = ? AND (${txWhere})`,
          [txId, userId, userId],
        );
        if (!delRes.affectedRows) {
          return json(404, { error: "見つかりません" }, hdrs, skipCors);
        }
        return json(200, { ok: true }, hdrs, skipCors);
      }

      case "GET /summary/month": {
        const ym = q.year_month || q.yearMonth;
        const familyScopeOnly = String(q.scope ?? "").toLowerCase() === "family";
        const txWhereForScope = familyScopeOnly ? txWhereFamily : txWhere;
        const txScopeParams = familyScopeOnly ? [userId] : [userId, userId];
        const bounds = ymBounds(ym);
        if (!bounds) {
          return json(
            400,
            { error: "year_month=YYYY-MM が必要です" },
            hdrs,
            skipCors,
          );
        }
        const { from, to } = bounds;
        const [expRows] = await pool.query(
          `SELECT c.id AS category_id, c.name AS category_name, COALESCE(SUM(t.amount),0) AS total
           FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
           WHERE ${txWhereForScope}
           AND t.transaction_date >= ? AND t.transaction_date <= ?
           AND t.kind = 'expense'
           GROUP BY c.id, c.name
           ORDER BY total DESC`,
          [...txScopeParams, from, to],
        );
        const [incRows] = await pool.query(
          `SELECT c.id AS category_id, c.name AS category_name, COALESCE(SUM(t.amount),0) AS total
           FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
           WHERE ${txWhereForScope}
           AND t.transaction_date >= ? AND t.transaction_date <= ?
           AND t.kind = 'income'
           GROUP BY c.id, c.name
           ORDER BY total DESC`,
          [...txScopeParams, from, to],
        );
        const [[sumE]] = await pool.query(
          `SELECT COALESCE(SUM(t.amount),0) AS total FROM transactions t
           WHERE ${txWhereForScope}
           AND t.transaction_date >= ? AND t.transaction_date <= ? AND t.kind = 'expense'`,
          [...txScopeParams, from, to],
        );
        const [[sumI]] = await pool.query(
          `SELECT COALESCE(SUM(t.amount),0) AS total FROM transactions t
           WHERE ${txWhereForScope}
           AND t.transaction_date >= ? AND t.transaction_date <= ? AND t.kind = 'income'`,
          [...txScopeParams, from, to],
        );
        return json(
          200,
          {
            year_month: ym,
            from,
            to,
            expenseTotal: sumE.total,
            incomeTotal: sumI.total,
            expensesByCategory: expRows,
            incomesByCategory: incRows,
          },
          hdrs,
          skipCors,
        );
      }

      case "GET /settings/fixed-costs": {
        if (!familyId) {
          return json(
            400,
            { error: "家族が設定されていません" },
            hdrs,
            skipCors,
          );
        }
        const memberOk = await verifyUserInFamily(pool, userId, familyId);
        if (!memberOk) {
          return json(403, { error: "この家族の固定費を参照する権限がありません" }, hdrs, skipCors);
        }
        const [rows] = await pool.query(
          `SELECT id, label AS category, amount, sort_order
           FROM family_fixed_cost_items
           WHERE family_id = ?
           ORDER BY sort_order ASC, id ASC`,
          [familyId],
        );
        return json(200, { items: rows }, hdrs, skipCors);
      }

      case "PUT /settings/fixed-costs": {
        if (!familyId) {
          return json(
            400,
            { error: "家族が設定されていません" },
            hdrs,
            skipCors,
          );
        }
        const memberOkPut = await verifyUserInFamily(pool, userId, familyId);
        if (!memberOkPut) {
          return json(403, { error: "この家族の固定費を保存する権限がありません" }, hdrs, skipCors);
        }
        let b;
        try {
          b = JSON.parse(req.body || "{}");
        } catch {
          return json(400, { error: "JSON が不正です" }, hdrs, skipCors);
        }
        const fixedSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (fixedSubRej) return fixedSubRej;
        const rawItems = Array.isArray(b.items) ? b.items : [];
        if (rawItems.length > 200) {
          return json(400, { error: "固定費は200行までです" }, hdrs, skipCors);
        }
        const normalized = [];
        for (let i = 0; i < rawItems.length; i += 1) {
          const row = rawItems[i];
          const labelRaw =
            row?.label != null && row.label !== ""
              ? String(row.label)
              : String(row?.category ?? "");
          const label = labelRaw.trim().slice(0, 100);
          const amount = Math.max(0, Math.round(Number(row?.amount ?? 0)));
          if (label.length === 0 || amount <= 0) continue;
          normalized.push({ label, amount });
        }
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          await conn.query(`DELETE FROM family_fixed_cost_items WHERE family_id = ?`, [
            familyId,
          ]);
          for (let i = 0; i < normalized.length; i += 1) {
            const { label, amount } = normalized[i];
            await conn.query(
              `INSERT INTO family_fixed_cost_items (family_id, label, amount, sort_order)
               VALUES (?, ?, ?, ?)`,
              [familyId, label, amount, i],
            );
          }
          await conn.commit();
        } catch (e) {
          await conn.rollback();
          logError("settings.fixed-costs.put", e);
          return json(500, { error: "固定費の保存に失敗しました" }, hdrs, skipCors);
        } finally {
          conn.release();
        }
        return json(200, { ok: true }, hdrs, skipCors);
      }

      case "POST /ai/advisor": {
        const b = JSON.parse(req.body || "{}");
        const advSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (advSubRej) return advSubRej;
        const message = String(b.message ?? "").trim();
        if (!message) {
          return json(400, { error: "message が必要です" }, hdrs, skipCors);
        }
        const ctx = b.context && typeof b.context === "object" ? b.context : {};
        let bedrockDetail = "";
        let aiResult = null;
        let bedrockThrown = null;
        try {
          aiResult = await askBedrockAdvisor(message, ctx);
          if (aiResult?.ok && aiResult.reply) {
            return json(200, { ok: true, reply: aiResult.reply, source: "bedrock" }, hdrs, skipCors);
          }
          if (aiResult && !aiResult.ok) {
            const detailParts = [aiResult.code, aiResult.message].filter(Boolean);
            bedrockDetail = detailParts.join(": ").slice(0, 280) || "BedrockUnavailable";
            logError(
              "ai.advisor.bedrock",
              new Error(`${aiResult.code}: ${aiResult.message}`),
              {
                authFailed: !!aiResult.authFailed,
                throttled: !!aiResult.throttled,
                validationFailed: !!aiResult.validationFailed,
                attemptsLog: aiResult.attemptsLog,
              },
            );
          }
        } catch (e) {
          bedrockThrown = e;
          const msg = e instanceof Error ? e.message : String(e);
          const authFailed =
            msg.includes("AuthError") ||
            msg.includes("AccessDeniedException") ||
            msg.includes("ExpiredTokenException") ||
            msg.includes("UnrecognizedClientException");
          const throttled =
            msg.includes("RateLimitError") ||
            msg.includes("ThrottlingException") ||
            msg.includes("TooManyRequestsException");
          const validationFailed =
            msg.includes("ValidationException") || (e && e.name === "ValidationException");
          bedrockDetail = authFailed
            ? `AccessDeniedException: ${msg.slice(0, 220)}`
            : throttled
              ? `ThrottlingException: ${msg.slice(0, 220)}`
              : validationFailed
                ? `ValidationException: ${msg.slice(0, 220)}`
                : `BedrockUnavailable: ${msg.slice(0, 220)}`;
          logError("ai.advisor.bedrock", e, {
            authFailed,
            throttled,
            validationFailed,
          });
        }

        const debugAdvisor =
          String(process.env.AI_ADVISOR_DEBUG_ERRORS ?? "").trim() === "1";
        if (debugAdvisor) {
          const stack =
            bedrockThrown instanceof Error
              ? String(bedrockThrown.stack || bedrockThrown.message)
              : bedrockThrown != null
                ? String(bedrockThrown)
                : "";
          const attemptsSnippet =
            aiResult?.attemptsLog != null
              ? JSON.stringify(aiResult.attemptsLog).slice(0, 3500)
              : "";
          const reply = [
            "[AI/Bedrock デバッグ] モデル応答を取得できませんでした。",
            "",
            "概要:",
            bedrockDetail || "(詳細なし)",
            "",
            stack ? "スタック:\n" + stack.slice(0, 6000) : "",
            attemptsSnippet ? "\n試行ログ（抜粋）:\n" + attemptsSnippet : "",
          ]
            .filter(Boolean)
            .join("\n")
            .slice(0, 12000);
          return json(
            200,
            {
              ok: true,
              reply,
              source: "error",
              sourceDetail: bedrockDetail,
              advisorDebug: true,
            },
            hdrs,
            skipCors,
          );
        }

        const reply = buildAdvisorFallbackReply(message, ctx);
        return json(
          200,
          {
            ok: true,
            reply,
            source: "fallback",
            ...(bedrockDetail ? { sourceDetail: bedrockDetail } : {}),
          },
          hdrs,
          skipCors,
        );
      }

      case "POST /import/csv": {
        const b = JSON.parse(req.body || "{}");
        const csvSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (csvSubRej) return csvSubRej;
        const text = String(b.csvText || "");
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        /** @type {Array<{ dateStr: string; categoryRaw: string; amount: number; memoVal: string | null }>} */
        const validRows = [];
        for (const line of lines) {
          const parts = line.split(/[,，\t]/).map((s) => s.trim());
          if (parts.length < 3) continue;
          const categoryRaw = parts[0];
          const dateStr = parts[1].replace(/\//g, "-");
          const amount = Number.parseFloat(parts[2].replace(/[,円]/g, ""));
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !Number.isFinite(amount)) {
            continue;
          }
          let memo = parts.slice(3).join(" ").trim();
          if (memo.length > 500) memo = memo.slice(0, 500);
          const memoVal = memo || null;
          validRows.push({
            dateStr,
            categoryRaw,
            amount: Math.abs(amount),
            memoVal,
          });
        }
        if (validRows.length === 0) {
          return json(
            200,
            {
              ok: true,
              deleted: 0,
              inserted: 0,
              categoriesCreated: 0,
              message:
                "有効な行がありません。カテゴリ,日付,金額（YYYY-MM-DD）の形式を確認してください。",
            },
            hdrs,
            skipCors,
          );
        }
        const ymSet = new Set();
        for (const r of validRows) {
          ymSet.add(r.dateStr.slice(0, 7));
        }
        /** @type {Array<{ from: string; to: string }>} */
        const monthRanges = [];
        for (const ym of [...ymSet].sort()) {
          const bounds = ymBounds(ym);
          if (bounds) monthRanges.push(bounds);
        }
        if (monthRanges.length === 0) {
          return json(
            500,
            {
              error: "CsvImportError",
              detail: "CSV の日付から年月を解釈できませんでした。",
            },
            hdrs,
            skipCors,
          );
        }
        const monthOr = monthRanges
          .map(() => "(t.transaction_date >= ? AND t.transaction_date <= ?)")
          .join(" OR ");
        const delParams = [userId, userId];
        for (const { from, to } of monthRanges) {
          delParams.push(from, to);
        }
        const [delRes] = await pool.query(
          `DELETE FROM transactions t
           WHERE ${txWhere}
           AND t.kind = 'expense'
           AND (${monthOr})`,
          delParams,
        );
        const deleted =
          delRes && typeof delRes.affectedRows === "number"
            ? delRes.affectedRows
            : 0;
        let inserted = 0;
        let categoriesCreated = 0;
        /** @type {Map<string, number>} */
        const csvCategoryByNorm = new Map();
        for (const row of validRows) {
          const { categoryId, created } = await findOrCreateExpenseCategoryByName(
            pool,
            userId,
            familyId,
            catWhere,
            row.categoryRaw,
            csvCategoryByNorm,
          );
          if (created) categoriesCreated += 1;
          await pool.query(
            `INSERT INTO transactions (user_id, family_id, kind, amount, transaction_date, memo, category_id)
             VALUES (?, ?, 'expense', ?, ?, ?, ?)`,
            [
              userId,
              familyId,
              row.amount,
              row.dateStr,
              row.memoVal,
              categoryId,
            ],
          );
          inserted += 1;
        }
        return json(
          200,
          {
            ok: true,
            deleted,
            inserted,
            categoriesCreated,
            message:
              "CSV の行に現れる年月（YYYY-MM）ごとに、その月の既存の支出を削除してから行を追加しました。カテゴリ列が空なら未分類、未登録名は支出カテゴリとして自動追加します。収入は削除しません。",
          },
          hdrs,
          skipCors,
        );
      }

      case "POST /receipts/learn": {
        const b = JSON.parse(req.body || "{}");
        const learnSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (learnSubRej) return learnSubRej;
        const summary = b.summary;
        const items = Array.isArray(b.items) ? b.items : [];
        if (summary == null || typeof summary !== "object") {
          return json(
            400,
            { error: "InvalidRequest", detail: "summary（取込データ）が必要です。" },
            hdrs,
            skipCors,
          );
        }
        const snapshot = buildReceiptOcrSnapshot(summary, items);
        const matchKey = receiptOcrMatchKey(summary, items);
        let categoryId = null;
        if (b.category_id != null && b.category_id !== "") {
          const n = Number(b.category_id);
          if (!Number.isFinite(n) || n <= 0) {
            return json(
              400,
              { error: "InvalidRequest", detail: "category_id が不正です。" },
              hdrs,
              skipCors,
            );
          }
          categoryId = n;
        }
        let memo = b.memo == null || b.memo === "" ? null : String(b.memo).trim().slice(0, 500);
        if (memo === "") memo = null;

        try {
          const [existing] = await pool.query(
            `SELECT category_id, memo FROM receipt_ocr_corrections
             WHERE user_id = ? AND match_key = ? LIMIT 1`,
            [userId, matchKey],
          );
          const ex = Array.isArray(existing) && existing[0];
          const exCat =
            ex?.category_id != null && ex.category_id !== ""
              ? Number(ex.category_id)
              : null;
          const exMemo = ex?.memo != null ? String(ex.memo) : null;
          const sameCat = (exCat ?? null) === (categoryId ?? null);
          const sameMemo = (exMemo ?? "") === (memo ?? "");
          if (ex && sameCat && sameMemo) {
            return json(200, { ok: true, skipped: true }, hdrs, skipCors);
          }

          const jsonSnap = JSON.stringify(snapshot);
          await pool.query(
            `INSERT INTO receipt_ocr_corrections
              (user_id, family_id, match_key, ocr_snapshot_json, category_id, memo)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               family_id = VALUES(family_id),
               ocr_snapshot_json = VALUES(ocr_snapshot_json),
               category_id = VALUES(category_id),
               memo = VALUES(memo),
               updated_at = CURRENT_TIMESTAMP`,
            [userId, familyId, matchKey, jsonSnap, categoryId, memo],
          );
          return json(200, { ok: true, skipped: false }, hdrs, skipCors);
        } catch (e) {
          const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
          if (code === "ER_NO_SUCH_TABLE") {
            return json(
              503,
              {
                error: "ReceiptLearnUnavailable",
                detail:
                  "receipt_ocr_corrections テーブルがありません。db/migration_v5_receipt_ocr_corrections.sql を実行してください。",
              },
              hdrs,
              skipCors,
            );
          }
          logError("receipts.learn", e);
          return json(
            500,
            { error: "ReceiptLearnError", detail: "補正データの保存に失敗しました。" },
            hdrs,
            skipCors,
          );
        }
      }

      case "POST /receipts/parse": {
        const b = JSON.parse(req.body || "{}");
        const subRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (subRej) return subRej;
        if (b.imageBase64 == null || typeof b.imageBase64 !== "string") {
          return json(
            400,
            {
              error: "InvalidRequest",
              detail:
                "imageBase64（JPEG/PNG 等の base64、または data URL）が必要です。",
            },
            hdrs,
            skipCors,
          );
        }
        try {
          const buf = decodeImageBuffer(b.imageBase64);
          const result = await analyzeReceiptImageBytes(buf, { logError });
          const [expenseCats] = await pool.query(
            `SELECT c.id, c.name
             FROM categories c
             WHERE ${catWhere} AND c.is_archived = 0 AND c.kind = 'expense'
             ORDER BY c.sort_order, c.id`,
            [userId, userId],
          );
          const expenseCatRows = Array.isArray(expenseCats) ? expenseCats : [];
          const suggestedCategory = await suggestExpenseCategoryForReceipt(
            pool,
            userId,
            catWhere,
            txWhere,
            result?.summary?.vendorName ?? "",
            result?.items ?? [],
          );
          const subscriptionStatus = await loadUserSubscriptionStatus(pool, userId);
          let subscriptionActive = isSubscriptionActive(subscriptionStatus);
          let debugReceiptTierOverride = null;
          if (isReceiptSubscriptionDebugAllowed()) {
            const raw =
              b.debugForceReceiptTier != null
                ? String(b.debugForceReceiptTier).trim().toLowerCase()
                : "";
            if (raw === "free" || raw === "subscribed") {
              debugReceiptTierOverride = raw;
              subscriptionActive = raw === "subscribed";
            }
          }
          const historyHints = subscriptionActive
            ? await fetchReceiptSubscriptionHistoryHints(pool, userId, txWhere)
            : [];
          let aiReceipt = null;
          try {
            aiReceipt = await askBedrockReceiptAssistant({
              subscriptionActive,
              historyHints,
              heuristicCategorySuggestion: suggestedCategory
                ? {
                    name: suggestedCategory.name,
                    source: suggestedCategory.source,
                  }
                : null,
              summary: result?.summary ?? {},
              items: result?.items ?? [],
              ocrLines: result?.ocrLines ?? [],
              categoryCandidates: expenseCatRows.map((c) => c.name),
              imageBase64: buf.toString("base64"),
              imageMediaType: inferReceiptImageMediaTypeFromBuffer(buf),
            });
          } catch (e) {
            logError("receipts.parse.ai_assist", e);
          }

          let adjustedSummary = { ...(result?.summary ?? {}) };
          let aiCategoryId = null;
          let aiCategoryName = null;
          if (aiReceipt?.ok && aiReceipt.data) {
            const d = aiReceipt.data;
            if (!subscriptionActive) {
              d.vendorName = null;
              d.categoryName = null;
            }
            const aiVendor = String(d.vendorName ?? "").trim();
            const aiDate = String(d.date ?? "").trim();
            const aiTotal = Number(d.totalAmount ?? NaN);
            const aiCat = String(d.categoryName ?? "").trim();
            if (
              subscriptionActive &&
              aiVendor &&
              (!adjustedSummary.vendorName ||
                String(adjustedSummary.vendorName).trim().length < 2 ||
                /^(不明|unknown|不詳)$/i.test(String(adjustedSummary.vendorName).trim()))
            ) {
              adjustedSummary.vendorName = aiVendor.slice(0, 120);
            }
            if (aiDate && /^\d{4}-\d{2}-\d{2}$/.test(aiDate) && !adjustedSummary.date) {
              adjustedSummary.date = aiDate;
            }
            if (Number.isFinite(aiTotal) && aiTotal > 0) {
              const current = Number(adjustedSummary.totalAmount ?? NaN);
              if (!Number.isFinite(current) || current <= 0 || aiTotal > current * 1.15) {
                adjustedSummary.totalAmount = Math.round(aiTotal);
              }
            }
            if (subscriptionActive && aiCat) {
              aiCategoryId = pickCategoryIdByAiName(aiCat, expenseCatRows);
              if (aiCategoryId != null) {
                const hit = expenseCatRows.find((x) => Number(x.id) === Number(aiCategoryId));
                aiCategoryName = hit?.name ? String(hit.name) : aiCat;
              }
            }
            if (
              subscriptionActive &&
              aiReceipt.receiptAiSource === "vision" &&
              (d.vendorName == null || String(d.vendorName).trim() === "")
            ) {
              const cur = String(adjustedSummary.vendorName ?? "").trim();
              if (
                !cur ||
                cur.length < 2 ||
                /^(不明|unknown|不詳)$/i.test(cur) ||
                /^[-_/|\s・。]+$/.test(cur)
              ) {
                adjustedSummary.vendorName = null;
              }
            }
          }

          let learnCorrectionHit = false;
          let learnedCategoryId = null;
          let learnedCategoryName = null;
          let learnedMemoPresent = false;
          let learnedMemoValue = "";
          let learnedMode = null;
          try {
            const learned = await findLearnedReceiptCorrection(
              pool,
              userId,
              catWhere,
              result?.summary,
              result?.items ?? [],
            );
            if (learned?.hit) {
              const hasCat = learned.categoryId != null;
              const hasMemo = learned.memoPresent;
              if (hasCat || hasMemo) {
                learnCorrectionHit = true;
                learnedMode = learned.mode;
                if (hasCat) {
                  learnedCategoryId = Number(learned.categoryId);
                  const [cn] = await pool.query(
                    `SELECT c.name FROM categories c
                     WHERE ${catWhere} AND c.id = ? AND c.is_archived = 0 LIMIT 1`,
                    [userId, userId, learnedCategoryId],
                  );
                  if (Array.isArray(cn) && cn[0]?.name) {
                    learnedCategoryName = String(cn[0].name);
                  }
                }
                if (hasMemo) {
                  learnedMemoPresent = true;
                  learnedMemoValue = learned.memoValue;
                }
              }
            }
          } catch (e) {
            const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
            if (code !== "ER_NO_SUCH_TABLE") {
              logError("receipts.parse.correction_lookup", e);
            }
          }

          const finalSuggestedId =
            learnedCategoryId != null
              ? learnedCategoryId
              : aiCategoryId != null
                ? aiCategoryId
                : suggestedCategory?.id ?? null;
          const finalSuggestedName =
            learnedCategoryId != null
              ? learnedCategoryName
              : aiCategoryName != null
                ? aiCategoryName
                : suggestedCategory?.name ?? null;
          const finalSource =
            learnCorrectionHit &&
            (learnedCategoryId != null || learnedMemoPresent)
              ? "correction"
              : aiCategoryId != null
                ? "ai"
                : suggestedCategory?.source ?? null;

          let duplicateWarning = null;
          try {
            const ymd = normalizeReceiptDateForSql(adjustedSummary?.date);
            const tot = Number(adjustedSummary?.totalAmount ?? NaN);
            const memoForDup =
              learnCorrectionHit && learnedMemoPresent
                ? normalizeTxMemo(learnedMemoValue)
                : normalizeTxMemo(adjustedSummary?.vendorName);
            if (ymd && Number.isFinite(tot) && tot > 0) {
              const [exRows] = await pool.query(
                `SELECT t.id FROM transactions t
                 WHERE t.user_id = ?
                   AND t.kind = 'expense'
                   AND t.transaction_date = ?
                   AND t.amount = ?
                   AND (t.memo <=> ?)
                 LIMIT 1`,
                [userId, ymd, tot, memoForDup],
              );
              if (Array.isArray(exRows) && exRows.length > 0) {
                duplicateWarning =
                  "既に登録済です（同じお店・日付・金額の取引が登録されています）";
              }
            }
          } catch (eDup) {
            logError("receipts.parse.duplicate_check", eDup);
          }

          const body = {
            ok: true,
            demo: false,
            summary: adjustedSummary,
            items: result.items,
            notice: result.notice,
            expenseIndex: result.expenseIndex,
            learnCorrectionHit,
            suggestedCategoryId: finalSuggestedId,
            suggestedCategoryName: finalSuggestedName ?? null,
            suggestedCategorySource: finalSource,
            suggestedCategoryCorrectionMode: learnedMode,
            subscriptionActive,
            receiptAiTier: aiReceipt?.receiptAiTier ?? null,
            debugReceiptTierOverride,
            subscriptionMockedByEnv: isUserIdForcedPremiumByEnv(userId),
          };
          if (learnCorrectionHit && learnedMemoPresent) {
            body.suggestedMemo = learnedMemoValue;
          }
          if (duplicateWarning) {
            body.duplicateWarning = duplicateWarning;
          }
          return json(200, body, hdrs, skipCors);
        } catch (e) {
          const status =
            e &&
            typeof e === "object" &&
            "statusCode" in e &&
            Number.isFinite(Number(e.statusCode))
              ? Number(e.statusCode)
              : 500;
          const code =
            e && typeof e === "object" && "code" in e && e.code
              ? String(e.code)
              : "ReceiptParseError";
          logError("receipts.parse", e, { code, status });
          // Textract の一時障害時は手入力フローを継続できるよう 200 で返す。
          if (
            code === "TextractTimeout" ||
            code === "TextractNetworkBusy" ||
            code === "TextractThrottled" ||
            code === "ServiceUnavailableException" ||
            code === "InternalServerError"
          ) {
            return json(
              200,
              {
                ok: true,
                demo: false,
                summary: { vendorName: null, totalAmount: null, date: null, fieldConfidence: {} },
                items: [],
                notice:
                  "自動解析を一時的に利用できませんでした。店舗名・金額・日付を手入力して登録できます。",
                expenseIndex: null,
              },
              hdrs,
              skipCors,
            );
          }
          return json(
            status,
            {
              error: code,
              detail:
                e instanceof Error
                  ? e.message
                  : typeof e === "string"
                    ? e
                    : "レシート解析に失敗しました。",
            },
            hdrs,
            skipCors,
          );
        }
      }

      case "POST /receipts/reclassify-uncategorized": {
        const b = JSON.parse(req.body || "{}");
        const subRej2 = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (subRej2) return subRej2;
        const batchSizeRaw = Number.parseInt(String(b.batchSize ?? "100"), 10);
        const batchSize =
          Number.isFinite(batchSizeRaw) && batchSizeRaw > 0
            ? Math.min(batchSizeRaw, 500)
            : 100;
        const maxBatchesRaw = Number.parseInt(String(b.maxBatches ?? "2000"), 10);
        const maxBatches =
          Number.isFinite(maxBatchesRaw) && maxBatchesRaw > 0
            ? Math.min(maxBatchesRaw, 5000)
            : 2000;

        let totalScanned = 0;
        let totalUpdated = 0;
        let offset = 0;
        let batches = 0;

        while (batches < maxBatches) {
          const [rows] = await pool.query(
            `SELECT t.id, t.memo
             FROM transactions t
             WHERE ${txWhere}
               AND t.kind = 'expense'
               AND t.category_id IS NULL
               AND t.memo IS NOT NULL
               AND TRIM(t.memo) <> ''
             ORDER BY t.transaction_date ASC, t.id ASC
             LIMIT ? OFFSET ?`,
            [userId, userId, batchSize, offset],
          );
          const list = Array.isArray(rows) ? rows : [];
          if (list.length === 0) break;

          batches += 1;
          let batchUpdated = 0;
          for (const r of list) {
            const txId = Number(r.id);
            const memo = String(r.memo ?? "");
            if (!Number.isFinite(txId) || !memo.trim()) continue;
            const suggestion = await suggestExpenseCategoryForMemo(
              pool,
              userId,
              catWhere,
              txWhere,
              memo,
            );
            if (!suggestion?.id) continue;
            const [upd] = await pool.query(
              `UPDATE transactions t
               SET t.category_id = ?
               WHERE t.id = ? AND (${txWhere}) AND t.category_id IS NULL`,
              [suggestion.id, txId, userId, userId],
            );
            if (upd?.affectedRows) {
              batchUpdated += 1;
              totalUpdated += 1;
            }
          }
          totalScanned += list.length;
          if (batchUpdated > 0) {
            offset = 0;
          } else {
            offset += list.length;
          }
        }

        return json(
          200,
          {
            ok: true,
            scanned: totalScanned,
            updated: totalUpdated,
            batches,
            batchSize,
          },
          hdrs,
          skipCors,
        );
      }

      default:
        return json(404, { error: "Not Found", path, method }, hdrs, skipCors);
    }
  } catch (e) {
    if (e && typeof e === "object" && e.code === "DATABASE_NOT_CONFIGURED") {
      return json(
        503,
        {
          error: "DatabaseNotConfigured",
          detail: e instanceof Error ? e.message : String(e),
        },
        hdrs,
        skipCors,
      );
    }
    logError("api.unhandled", e, { method, path });
    const dev = process.env.NODE_ENV === "development";
    const dbCode =
      e && typeof e === "object" && e.code != null ? String(e.code) : "";
    const errno =
      e && typeof e === "object" && typeof e.errno === "number"
        ? e.errno
        : null;
    const detail = dev
      ? e instanceof Error
        ? e.message
        : String(e)
      : dbCode || errno != null
        ? dbCode || `errno:${errno}`
        : undefined;
    return json(
      500,
      {
        error: "InternalError",
        ...(detail ? { detail } : {}),
      },
      hdrs,
      skipCors,
    );
  }
}

export { resolveUserId };
