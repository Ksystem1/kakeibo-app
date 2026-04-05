/**
 * カテゴリ名の重複判定（NFKC・空白正規化・英字小文字）
 * @param {string|null|undefined} name
 */
export function normalizeCategoryNameKey(name) {
  return String(name ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * 同一ユーザー／家族スコープで、正規化名が同じカテゴリを1つにまとめる。
 * 取引・予算・receipt_ocr_corrections を代表 ID に付け替え、他はアーカイブ。
 * @returns {Promise<{ merged: number }>}
 */
export async function mergeDuplicateCategories(pool, userId, familyId, catWhere, txWhere) {
  const [rows] = await pool.query(
    `SELECT c.id, c.name, c.kind FROM categories c
     WHERE ${catWhere} AND c.is_archived = 0
     ORDER BY c.kind ASC, c.id ASC`,
    [userId, userId],
  );
  if (!Array.isArray(rows) || rows.length < 2) {
    return { merged: 0 };
  }

  /** @type {Map<string, Array<{ id: number; name: string; kind: string }>>} */
  const groups = new Map();
  for (const r of rows) {
    const id = Number(r.id);
    const kind = String(r.kind ?? "expense");
    const key = `${kind}::${normalizeCategoryNameKey(r.name)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id, name: String(r.name ?? ""), kind });
  }

  let merged = 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    for (const [, list] of groups) {
      if (list.length < 2) continue;

      const ids = list.map((x) => x.id);
      const placeholders = ids.map(() => "?").join(",");
      const [txRows] = await conn.query(
        `SELECT t.category_id AS cid, COUNT(*) AS n
         FROM transactions t
         WHERE (${txWhere}) AND t.category_id IN (${placeholders})
         GROUP BY t.category_id`,
        [userId, userId, ...ids],
      );
      const countMap = new Map();
      for (const tr of txRows || []) {
        countMap.set(Number(tr.cid), Number(tr.n));
      }

      list.sort((a, b) => {
        const na = countMap.get(a.id) ?? 0;
        const nb = countMap.get(b.id) ?? 0;
        if (nb !== na) return nb - na;
        return a.id - b.id;
      });

      const keeper = list[0];
      const dupes = list.slice(1);

      for (const d of dupes) {
        const dupeId = d.id;

        await reassignBudgetsForCategoryMerge(conn, userId, dupeId, keeper.id);

        await conn.query(
          `UPDATE transactions t SET t.category_id = ?, t.updated_at = NOW()
           WHERE (${txWhere}) AND t.category_id = ?`,
          [keeper.id, userId, userId, dupeId],
        );

        try {
          await conn.query(
            `UPDATE receipt_ocr_corrections SET category_id = ?, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND category_id = ?`,
            [keeper.id, userId, dupeId],
          );
        } catch (e) {
          const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
          if (code !== "ER_NO_SUCH_TABLE") throw e;
        }

        await conn.query(
          `UPDATE categories c SET c.is_archived = 1, c.updated_at = NOW()
           WHERE c.id = ? AND (${catWhere})`,
          [dupeId, userId, userId],
        );
        merged += 1;
      }
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  return { merged };
}

/**
 * @param {import("mysql2/promise").PoolConnection} conn
 */
async function reassignBudgetsForCategoryMerge(conn, userId, fromCatId, toCatId) {
  const [buds] = await conn.query(
    `SELECT id, year_month, amount_limit FROM budgets
     WHERE user_id = ? AND category_id = ?`,
    [userId, fromCatId],
  );
  for (const b of buds || []) {
    const [[ex]] = await conn.query(
      `SELECT id, amount_limit FROM budgets
       WHERE user_id = ? AND category_id = ? AND year_month = ?`,
      [userId, toCatId, b.year_month],
    );
    if (ex) {
      const sum =
        Number(ex.amount_limit) + Number(b.amount_limit);
      await conn.query(`UPDATE budgets SET amount_limit = ? WHERE id = ?`, [
        sum,
        ex.id,
      ]);
      await conn.query(`DELETE FROM budgets WHERE id = ?`, [b.id]);
    } else {
      await conn.query(`UPDATE budgets SET category_id = ? WHERE id = ?`, [
        toCatId,
        b.id,
      ]);
    }
  }
}
