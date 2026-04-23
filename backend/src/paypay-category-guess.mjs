/**
 * PayPay 明細行の category_id 解決（学習履歴優先 → キーワード推測）
 */
import { normalizeCategoryNameKey } from "./category-utils.mjs";

/** app-core の RECEIPT_NORMALIZED_MEMO_EXPR と等価な正規化（比較用） */
export function normalizeMemoForHistoryLookup(memo) {
  return String(memo ?? "")
    .trim()
    .toLowerCase()
    .replace(/ /g, "")
    .replace(/　/g, "")
    .replace(/株式会社/g, "")
    .replace(/\(株\)/g, "");
}

const CATEGORY_ACCESS = `(c.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?) OR (c.family_id IS NULL AND c.user_id = ?))`;

const MEMO_NORM_SQL = `LOWER(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(t.memo), ' ', ''), '　', ''), '株式会社', ''), '(株)', ''))`;

/**
 * 支出カテゴリ一覧
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 */
export async function fetchUserExpenseCategoryRows(pool, userId) {
  const [rows] = await pool.query(
    `SELECT c.id, c.name
     FROM categories c
     WHERE ${CATEGORY_ACCESS} AND c.is_archived = 0 AND c.kind = 'expense'`,
    [userId, userId],
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * 正規化名（複数エイリアス可） → 先にマッチしたカテゴリ id
 * @param {Map<string, number>} keyToId normalizeCategoryNameKey(name) -> id
 */
function pickCategoryIdByTargetNames(nameToId, targetNames) {
  for (const t of targetNames) {
    const k = normalizeCategoryNameKey(t);
    if (nameToId.has(k)) return nameToId.get(k);
  }
  return null;
}

/**
 * 取引先文字列のキーワードで category_id を推測
 * @param {string} merchantRaw
 * @param {Map<string, number>} nameToId
 * @returns {number | null}
 */
export function guessCategoryIdByMerchantKeywords(merchantRaw, nameToId) {
  const m = String(merchantRaw ?? "").toLowerCase();
  if (!m.trim()) return null;
  const rules = [
    {
      targets: ["食費"],
      kws: [
        "ファミリーマート",
        "セブン-イレブン",
        "セブンイレブン",
        "ローソン",
        "すき家",
        "マクドナルド",
        "スーパー",
        "飲食店",
        "ミニストップ",
        "デイリーヤマザキ",
        "星乃珈琲",
        "吉野家",
        "松屋",
        "王将",
        "焼肉",
        "回転寿司",
      ],
    },
    {
      targets: ["日用品"],
      kws: [
        "ドラッグストア",
        "マツモトキヨシ",
        "マツキヨ",
        "ウエルシア",
        "ダイソー",
        "セリア",
        "キャンドゥ",
        "コスモス",
      ],
    },
    {
      targets: ["交通費"],
      kws: ["タクシー", "鉄道", "ＪＲ", "jr", "バス", "メトロ", "地下鉄", "近鉄", "小田急", "京王", "相鉄", "京急"],
    },
    {
      targets: ["娯楽・趣味", "娯楽"],
      kws: ["極楽湯", "映画", "カラオケ", "usj", "ユニバーサル", "シネマ", "ディズニー", "劇場"],
    },
    {
      targets: ["医療・健康", "医療"],
      kws: ["メディカル", "クリニック", "美容室", "病院", "歯科", "薬局", "皮フ科", "医院"],
    },
  ];
  for (const rule of rules) {
    if (rule.kws.some((kw) => m.includes(String(kw).toLowerCase()))) {
      const id = pickCategoryIdByTargetNames(nameToId, rule.targets);
      if (id != null) return id;
    }
  }
  return null;
}

/**
 * 同じ正規化メモの直近取引のカテゴリ
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 * @param {string} memo 今回取り込む行のメモ文面
 * @param {Map<string, number | null | undefined>} [cache] normalize -> categoryId
 */
export async function fetchCategoryIdFromUserMemoHistory(pool, userId, memo, cache) {
  const n = normalizeMemoForHistoryLookup(memo);
  if (!n) return null;
  if (cache) {
    if (cache.has(n)) {
      const v = cache.get(n);
      return v == null || v === undefined ? null : Number(v);
    }
  }
  const [rows] = await pool.query(
    `SELECT t.category_id
     FROM transactions t
     INNER JOIN categories c ON c.id = t.category_id
     WHERE t.user_id = ?
       AND t.kind = 'expense'
       AND t.category_id IS NOT NULL
       AND c.kind = 'expense'
       AND c.is_archived = 0
       AND ${CATEGORY_ACCESS}
       AND ${MEMO_NORM_SQL} = ?
     ORDER BY t.transaction_date DESC, t.id DESC
     LIMIT 1`,
    [userId, userId, userId, n],
  );
  const cid =
    Array.isArray(rows) && rows[0]?.category_id != null
      ? Number(rows[0].category_id)
      : null;
  if (cache) {
    cache.set(n, cid);
  }
  return Number.isFinite(cid) && cid > 0 ? cid : null;
}

/**
 * 外部取引IDごとの既存 category_id
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 * @param {string[]} externalIds
 * @returns {Promise<Map<string, number | null>>}
 */
export async function fetchExistingCategoryIdByExternalIds(pool, userId, externalIds) {
  const out = new Map();
  if (externalIds.length === 0) return out;
  const chunkSize = 300;
  for (let i = 0; i < externalIds.length; i += chunkSize) {
    const chunk = externalIds.slice(i, i + chunkSize);
    const ph = chunk.map(() => "?").join(",");
    const [rows] = await pool.query(
      `SELECT external_transaction_id, category_id
       FROM transactions
       WHERE user_id = ? AND external_transaction_id IN (${ph})`,
      [userId, ...chunk],
    );
    for (const r of rows || []) {
      const ext = String(r.external_transaction_id ?? "").trim();
      if (!ext) continue;
      out.set(
        ext,
        r.category_id != null && r.category_id !== "" ? Number(r.category_id) : null,
      );
    }
  }
  return out;
}
