/**
 * 家族単位サブスク: users と families の結合に使う「所属 family_id」式（SQL 断片）
 * @param {string} userAlias users の別名（例: u）
 */
export function sqlUserFamilyIdExpr(userAlias = "u") {
  return `COALESCE(${userAlias}.default_family_id,(SELECT fm.family_id FROM family_members fm WHERE fm.user_id=${userAlias}.id ORDER BY fm.id LIMIT 1))`;
}
