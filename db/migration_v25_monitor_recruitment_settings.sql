-- v25: site_settings にモニター募集設定カラムを追加

SET NAMES utf8mb4;

SET @v25_db := DATABASE();

SET @v25_has_table := (
  SELECT COUNT(*)
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = @v25_db AND TABLE_NAME = 'site_settings'
);

SET @v25_sql_create_table := IF(
  @v25_has_table = 0,
  'CREATE TABLE site_settings (
     id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
     header_announcement VARCHAR(512) NOT NULL DEFAULT '''' COMMENT ''ヘッダー1行お知らせ（プレーンテキスト）'',
     monitor_recruitment_enabled TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''モニター募集表示フラグ（1=表示）'',
     monitor_recruitment_text VARCHAR(512) NOT NULL DEFAULT '''' COMMENT ''モニター募集案内文（管理者設定）'',
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1 AS migration_v25_site_settings_exists'
);
PREPARE v25_stmt_create_table FROM @v25_sql_create_table;
EXECUTE v25_stmt_create_table;
DEALLOCATE PREPARE v25_stmt_create_table;

SET @v25_has_monitor_enabled := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v25_db
    AND TABLE_NAME = 'site_settings'
    AND COLUMN_NAME = 'monitor_recruitment_enabled'
);
SET @v25_sql_add_monitor_enabled := IF(
  @v25_has_monitor_enabled = 0,
  'ALTER TABLE site_settings ADD COLUMN monitor_recruitment_enabled TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''モニター募集表示フラグ（1=表示）'' AFTER header_announcement',
  'SELECT 1 AS migration_v25_monitor_enabled_exists'
);
PREPARE v25_stmt_add_monitor_enabled FROM @v25_sql_add_monitor_enabled;
EXECUTE v25_stmt_add_monitor_enabled;
DEALLOCATE PREPARE v25_stmt_add_monitor_enabled;

SET @v25_has_monitor_text := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v25_db
    AND TABLE_NAME = 'site_settings'
    AND COLUMN_NAME = 'monitor_recruitment_text'
);
SET @v25_sql_add_monitor_text := IF(
  @v25_has_monitor_text = 0,
  'ALTER TABLE site_settings ADD COLUMN monitor_recruitment_text VARCHAR(512) NOT NULL DEFAULT '''' COMMENT ''モニター募集案内文（管理者設定）'' AFTER monitor_recruitment_enabled',
  'SELECT 1 AS migration_v25_monitor_text_exists'
);
PREPARE v25_stmt_add_monitor_text FROM @v25_sql_add_monitor_text;
EXECUTE v25_stmt_add_monitor_text;
DEALLOCATE PREPARE v25_stmt_add_monitor_text;

INSERT IGNORE INTO site_settings (
  id,
  header_announcement,
  monitor_recruitment_enabled,
  monitor_recruitment_text
) VALUES (1, '', 0, '');
