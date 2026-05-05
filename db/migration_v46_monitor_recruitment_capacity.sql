-- v46: モニター募集の定員（site_settings）と、登録経路で付与したユーザーの識別（users.is_monitor_recruit）

SET NAMES utf8mb4;

SET @v46_db := DATABASE();

SET @v46_has_cap := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v46_db
    AND TABLE_NAME = 'site_settings'
    AND COLUMN_NAME = 'monitor_recruitment_capacity'
);
SET @v46_sql_add_cap := IF(
  @v46_has_cap = 0,
  'ALTER TABLE site_settings ADD COLUMN monitor_recruitment_capacity INT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''モニター募集の定員（0=定員表示なし・枠制限なし）'' AFTER monitor_recruitment_text',
  'SELECT 1 AS migration_v46_capacity_exists'
);
PREPARE v46_stmt_cap FROM @v46_sql_add_cap;
EXECUTE v46_stmt_cap;
DEALLOCATE PREPARE v46_stmt_cap;

SET @v46_has_flag := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v46_db
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'is_monitor_recruit'
);
SET @v46_sql_add_flag := IF(
  @v46_has_flag = 0,
  'ALTER TABLE users ADD COLUMN is_monitor_recruit TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''モニター募集枠で登録特典を付与したユーザー'' AFTER is_premium',
  'SELECT 1 AS migration_v46_is_monitor_recruit_exists'
);
PREPARE v46_stmt_flag FROM @v46_sql_add_flag;
EXECUTE v46_stmt_flag;
DEALLOCATE PREPARE v46_stmt_flag;
