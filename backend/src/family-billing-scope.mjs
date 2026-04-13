/**
 * 家族単位サブスク: users と families の結合に使う「所属 family_id」式（SQL 断片）
 *
 * 方針:
 * - default_family_id が古い値のままでも、実際に契約中の家族を優先できるように
 *   family_members + families の状態で候補を並べ替える。
 * - 候補が無いときだけ default_family_id にフォールバック。
 * @param {string} userAlias users の別名（例: u）
 */
export function sqlUserFamilyIdExpr(userAlias = "u") {
  return `COALESCE(
    (
      SELECT fm.family_id
      FROM family_members fm
      LEFT JOIN families f ON f.id = fm.family_id
      WHERE fm.user_id = ${userAlias}.id
      ORDER BY
        CASE
          WHEN LOWER(COALESCE(f.subscription_status, '')) IN ('active','trialing','past_due') THEN 0
          WHEN TRIM(COALESCE(f.stripe_customer_id, '')) <> '' THEN 1
          ELSE 2
        END,
        COALESCE(f.updated_at, f.created_at, '1970-01-01') DESC,
        fm.id ASC
      LIMIT 1
    ),
    ${userAlias}.default_family_id
  )`;
}
