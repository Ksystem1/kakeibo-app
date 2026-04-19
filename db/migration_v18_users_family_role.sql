-- v18: users.family_role（家族内のデータスコープ。KID は取引 API で本人分のみ）
-- 適用例: cd backend && npm run db:migrate-v18
-- 任意データ例（ID は環境に合わせて変更）: 子ユーザーを家族 1 に寄せる場合
--   DELETE FROM family_members WHERE user_id IN (13, 14);
--   INSERT INTO family_members (family_id, user_id, role) VALUES (1, 13, 'member'), (1, 14, 'member');
--   UPDATE users SET default_family_id = 1, family_role = 'KID' WHERE id IN (13, 14);

SET NAMES utf8mb4;

SET @v18_db := DATABASE();
SET @v18_has := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v18_db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'family_role'
);
SET @v18_sql := IF(
  @v18_has = 0,
  'ALTER TABLE users ADD COLUMN family_role ENUM(''ADMIN'', ''MEMBER'', ''KID'') NOT NULL DEFAULT ''MEMBER'' COMMENT ''家族内権限: ADMIN/MEMBER=家族取引参照可 KID=本人の取引のみ'' AFTER default_family_id',
  'SELECT 1 AS migration_v18_family_role_skip'
);
PREPARE v18_stmt FROM @v18_sql;
EXECUTE v18_stmt;
DEALLOCATE PREPARE v18_stmt;
