-- v20: users.kid_theme（子ども向けきせかえ: blue / pink）。親が管理画面から設定。
-- 適用例: cd backend && npm run db:migrate-v20

SET NAMES utf8mb4;

SET @v20_db := DATABASE();
SET @v20_has := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v20_db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'kid_theme'
);
SET @v20_sql := IF(
  @v20_has = 0,
  'ALTER TABLE users ADD COLUMN kid_theme ENUM(''blue'', ''pink'') NULL DEFAULT NULL COMMENT ''子どもUIテーマ（KID向け）。NULL=既定ブルー系'' AFTER family_role',
  'SELECT 1 AS migration_v20_kid_theme_skip'
);
PREPARE v20_stmt FROM @v20_sql;
EXECUTE v20_stmt;
DEALLOCATE PREPARE v20_stmt;
