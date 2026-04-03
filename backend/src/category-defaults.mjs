/**
 * 家計簿でよく使う支出・収入カテゴリの初期セット。
 * GET /categories で0件のとき、または新規登録直後に投入する。
 */

/** @type {Array<{ name: string; color_hex: string | null; sort_order: number }>} */
export const DEFAULT_EXPENSE_CATEGORIES = [
  { name: "食費", color_hex: "#22c55e", sort_order: 10 },
  { name: "日用品", color_hex: "#3b82f6", sort_order: 20 },
  { name: "交通費", color_hex: "#8b5cf6", sort_order: 30 },
  { name: "通信費", color_hex: "#6366f1", sort_order: 40 },
  { name: "光熱費", color_hex: "#f59e0b", sort_order: 50 },
  { name: "医療・健康", color_hex: "#ec4899", sort_order: 60 },
  { name: "衣類", color_hex: "#a855f7", sort_order: 70 },
  { name: "教養・教育", color_hex: "#0ea5e9", sort_order: 80 },
  { name: "娯楽・趣味", color_hex: "#14b8a6", sort_order: 90 },
  { name: "交際費", color_hex: "#f97316", sort_order: 100 },
  { name: "住宅・家賃", color_hex: "#64748b", sort_order: 110 },
  { name: "税・保険", color_hex: "#78716c", sort_order: 120 },
  { name: "その他（支出）", color_hex: "#94a3b8", sort_order: 130 },
];

/** @type {Array<{ name: string; color_hex: string | null; sort_order: number }>} */
export const DEFAULT_INCOME_CATEGORIES = [
  { name: "給与", color_hex: "#22c55e", sort_order: 10 },
  { name: "ボーナス", color_hex: "#10b981", sort_order: 20 },
  { name: "副業・その他収入", color_hex: "#06b6d4", sort_order: 30 },
  { name: "おこづかい", color_hex: "#84cc16", sort_order: 40 },
  { name: "その他（収入）", color_hex: "#94a3b8", sort_order: 50 },
];

export const CATEGORY_ACCESS_WHERE = `(c.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?) OR (c.family_id IS NULL AND c.user_id = ?))`;

/** （未分類）・未分類（収入）などを同一視して「既定だけ」か判定する */
function normalizeNameForUnclassifiedCheck(name) {
  return String(name ?? "")
    .trim()
    .replace(/[（）()]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function isUnclassifiedLikeName(name) {
  const n = normalizeNameForUnclassifiedCheck(name);
  return n === "未分類" || n === "未分類収入";
}

/**
 * 利用可能なカテゴリが0件のときだけ、既定カテゴリを INSERT する。
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 * @param {number | null} familyId
 */
export async function seedDefaultCategoriesIfEmpty(pool, userId, familyId) {
  const [rows] = await pool.query(
    `SELECT c.id, c.name, c.kind
       FROM categories c
       WHERE ${CATEGORY_ACCESS_WHERE} AND c.is_archived = 0`,
    [userId, userId],
  );
  const existing = Array.isArray(rows) ? rows : [];
  if (existing.length > 0) {
    const onlyUnclassified = existing.every((r) =>
      isUnclassifiedLikeName(r.name),
    );
    if (!onlyUnclassified) {
      return { inserted: 0 };
    }
  }

  let inserted = 0;
  const existingNames = new Set(
    existing.map((r) => String(r.name ?? "").trim().toLowerCase()),
  );
  for (const row of DEFAULT_EXPENSE_CATEGORIES) {
    const key = row.name.trim().toLowerCase();
    if (existingNames.has(key)) continue;
    await pool.query(
      `INSERT INTO categories (user_id, family_id, parent_id, name, kind, color_hex, sort_order)
       VALUES (?, ?, NULL, ?, 'expense', ?, ?)`,
      [userId, familyId, row.name, row.color_hex, row.sort_order],
    );
    inserted += 1;
  }
  for (const row of DEFAULT_INCOME_CATEGORIES) {
    const key = row.name.trim().toLowerCase();
    if (existingNames.has(key)) continue;
    await pool.query(
      `INSERT INTO categories (user_id, family_id, parent_id, name, kind, color_hex, sort_order)
       VALUES (?, ?, NULL, ?, 'income', ?, ?)`,
      [userId, familyId, row.name, row.color_hex, row.sort_order],
    );
    inserted += 1;
  }
  return { inserted };
}
