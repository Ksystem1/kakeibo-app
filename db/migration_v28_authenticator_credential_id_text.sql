-- v28: authenticators.credential_id を base64url 用 VARCHAR で保持
-- 注意: utf8mb4 で文字列全長に一意インデックスを貼ると「Specified key was too long」になる
--   （VARCHAR(1024)×4 バイト > インデックス上限）。一意は credential_id(255) の接頭辞で付け直す。

SET NAMES utf8mb4;

SET @v28_db := DATABASE();

SET @v28_has_table := (
  SELECT COUNT(*)
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = @v28_db
    AND TABLE_NAME = 'authenticators'
);

-- 古いフル幅 UNIQUE を削除（接頭辞付きに付け直す前提）
SET @v28_idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @v28_db
    AND TABLE_NAME = 'authenticators'
    AND INDEX_NAME = 'uq_authenticators_credential_id'
);

SET @v28_sql_drop_uk := IF(
  @v28_has_table = 1 AND @v28_idx_exists >= 1,
  'ALTER TABLE authenticators DROP INDEX uq_authenticators_credential_id',
  'SELECT 1 AS migration_v28_no_uq_authenticators_credential_id'
);

PREPARE v28_stmt_drop_uk FROM @v28_sql_drop_uk;
EXECUTE v28_stmt_drop_uk;
DEALLOCATE PREPARE v28_stmt_drop_uk;

SET @v28_col_type := (
  SELECT LOWER(COALESCE(DATA_TYPE, ''))
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v28_db
    AND TABLE_NAME = 'authenticators'
    AND COLUMN_NAME = 'credential_id'
  LIMIT 1
);

-- VARBINARY 等から VARCHAR(1024) へ（既に varchar の場合はスキップ）
SET @v28_sql_modify := IF(
  @v28_has_table = 1 AND @v28_col_type <> 'varchar',
  'ALTER TABLE authenticators MODIFY COLUMN credential_id VARCHAR(1024) NOT NULL COMMENT ''WebAuthn credentialId（base64url）''',
  'SELECT 1 AS migration_v28_credential_id_already_varchar'
);

PREPARE v28_stmt_modify FROM @v28_sql_modify;
EXECUTE v28_stmt_modify;
DEALLOCATE PREPARE v28_stmt_modify;

-- 接頭辞 255 文字の UNIQUE（衝突リスクは実務上極小）
SET @v28_uk2_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @v28_db
    AND TABLE_NAME = 'authenticators'
    AND INDEX_NAME = 'uq_authenticators_credential_id'
);

SET @v28_sql_add_uk := IF(
  @v28_has_table = 1 AND @v28_uk2_exists = 0,
  'ALTER TABLE authenticators ADD UNIQUE KEY uq_authenticators_credential_id (credential_id(255))',
  'SELECT 1 AS migration_v28_uk_credential_id_already_present'
);

PREPARE v28_stmt_add_uk FROM @v28_sql_add_uk;
EXECUTE v28_stmt_add_uk;
DEALLOCATE PREPARE v28_stmt_add_uk;
