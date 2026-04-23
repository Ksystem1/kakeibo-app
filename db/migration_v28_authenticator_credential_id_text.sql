-- v28: authenticators.credential_id を base64url 文字列で保持

SET NAMES utf8mb4;

SET @v28_db := DATABASE();

SET @v28_has_table := (
  SELECT COUNT(*)
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = @v28_db
    AND TABLE_NAME = 'authenticators'
);

SET @v28_col_type := (
  SELECT LOWER(COALESCE(DATA_TYPE, ''))
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v28_db
    AND TABLE_NAME = 'authenticators'
    AND COLUMN_NAME = 'credential_id'
  LIMIT 1
);

SET @v28_sql_modify := IF(
  @v28_has_table = 1 AND @v28_col_type <> 'varchar',
  'ALTER TABLE authenticators MODIFY COLUMN credential_id VARCHAR(1024) NOT NULL COMMENT ''WebAuthn credentialId（base64url）''',
  'SELECT 1 AS migration_v28_credential_id_already_varchar'
);

PREPARE v28_stmt_modify FROM @v28_sql_modify;
EXECUTE v28_stmt_modify;
DEALLOCATE PREPARE v28_stmt_modify;
