-- v27: パスキー用リカバリーコード列（users）

SET NAMES utf8mb4;

SET @v27_db := DATABASE();

SET @v27_has_users := (
  SELECT COUNT(*)
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = @v27_db
    AND TABLE_NAME = 'users'
);

SET @v27_has_recovery_hash := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v27_db
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'recovery_code_hash'
);
SET @v27_sql_add_recovery_hash := IF(
  @v27_has_users = 1 AND @v27_has_recovery_hash = 0,
  'ALTER TABLE users ADD COLUMN recovery_code_hash CHAR(64) NULL COMMENT ''リカバリーコードのSHA-256'' AFTER auth_method',
  'SELECT 1 AS migration_v27_recovery_hash_exists'
);
PREPARE v27_stmt_add_recovery_hash FROM @v27_sql_add_recovery_hash;
EXECUTE v27_stmt_add_recovery_hash;
DEALLOCATE PREPARE v27_stmt_add_recovery_hash;

SET @v27_has_recovery_issued_at := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v27_db
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'recovery_code_issued_at'
);
SET @v27_sql_add_recovery_issued_at := IF(
  @v27_has_users = 1 AND @v27_has_recovery_issued_at = 0,
  'ALTER TABLE users ADD COLUMN recovery_code_issued_at DATETIME NULL COMMENT ''リカバリーコード発行日時'' AFTER recovery_code_hash',
  'SELECT 1 AS migration_v27_recovery_issued_at_exists'
);
PREPARE v27_stmt_add_recovery_issued_at FROM @v27_sql_add_recovery_issued_at;
EXECUTE v27_stmt_add_recovery_issued_at;
DEALLOCATE PREPARE v27_stmt_add_recovery_issued_at;

SET @v27_has_recovery_used_at := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v27_db
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'recovery_code_used_at'
);
SET @v27_sql_add_recovery_used_at := IF(
  @v27_has_users = 1 AND @v27_has_recovery_used_at = 0,
  'ALTER TABLE users ADD COLUMN recovery_code_used_at DATETIME NULL COMMENT ''リカバリーコード使用日時'' AFTER recovery_code_issued_at',
  'SELECT 1 AS migration_v27_recovery_used_at_exists'
);
PREPARE v27_stmt_add_recovery_used_at FROM @v27_sql_add_recovery_used_at;
EXECUTE v27_stmt_add_recovery_used_at;
DEALLOCATE PREPARE v27_stmt_add_recovery_used_at;
