-- v26: Passkey(WebAuthn) 共存のための基盤
-- - users.email / users.password_hash を NULL 許容に再保証
-- - users.auth_method ('email'|'passkey'|'both') を追加
-- - authenticators テーブルを新設

SET NAMES utf8mb4;

SET @v26_db := DATABASE();

SET @v26_has_users := (
  SELECT COUNT(*)
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = @v26_db
    AND TABLE_NAME = 'users'
);

SET @v26_has_email := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v26_db
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'email'
);

SET @v26_email_nullable := (
  SELECT COALESCE(MAX(CASE WHEN IS_NULLABLE = 'YES' THEN 1 ELSE 0 END), 0)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v26_db
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'email'
);

SET @v26_sql_users_email_nullable := IF(
  @v26_has_users = 1 AND @v26_has_email = 1 AND @v26_email_nullable = 0,
  'ALTER TABLE users MODIFY COLUMN email VARCHAR(255) NULL',
  'SELECT 1 AS migration_v26_email_nullable_skip'
);
PREPARE v26_stmt_users_email_nullable FROM @v26_sql_users_email_nullable;
EXECUTE v26_stmt_users_email_nullable;
DEALLOCATE PREPARE v26_stmt_users_email_nullable;

SET @v26_has_password_hash := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v26_db
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'password_hash'
);

SET @v26_password_hash_nullable := (
  SELECT COALESCE(MAX(CASE WHEN IS_NULLABLE = 'YES' THEN 1 ELSE 0 END), 0)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v26_db
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'password_hash'
);

SET @v26_sql_users_password_hash_nullable := IF(
  @v26_has_users = 1 AND @v26_has_password_hash = 1 AND @v26_password_hash_nullable = 0,
  'ALTER TABLE users MODIFY COLUMN password_hash VARCHAR(255) NULL COMMENT ''bcrypt''',
  'SELECT 1 AS migration_v26_password_hash_nullable_skip'
);
PREPARE v26_stmt_users_password_hash_nullable FROM @v26_sql_users_password_hash_nullable;
EXECUTE v26_stmt_users_password_hash_nullable;
DEALLOCATE PREPARE v26_stmt_users_password_hash_nullable;

SET @v26_has_auth_method := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v26_db
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'auth_method'
);

SET @v26_sql_add_auth_method := IF(
  @v26_has_users = 1 AND @v26_has_auth_method = 0,
  'ALTER TABLE users ADD COLUMN auth_method ENUM(''email'', ''passkey'', ''both'') NOT NULL DEFAULT ''email'' COMMENT ''認証方式: email/passkey/both'' AFTER email',
  'SELECT 1 AS migration_v26_auth_method_exists'
);
PREPARE v26_stmt_add_auth_method FROM @v26_sql_add_auth_method;
EXECUTE v26_stmt_add_auth_method;
DEALLOCATE PREPARE v26_stmt_add_auth_method;

SET @v26_has_authenticators := (
  SELECT COUNT(*)
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = @v26_db
    AND TABLE_NAME = 'authenticators'
);

SET @v26_sql_create_authenticators := IF(
  @v26_has_authenticators = 0,
  'CREATE TABLE authenticators (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     user_id BIGINT UNSIGNED NOT NULL,
     credential_id VARBINARY(1024) NOT NULL COMMENT ''WebAuthn credentialId(生バイト列)'',
     public_key BLOB NOT NULL COMMENT ''COSE public key'',
     counter BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''署名カウンタ'',
     transports VARCHAR(255) NULL COMMENT ''usb,nfc,ble,internal など（CSV）'',
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_authenticators_credential_id (credential_id),
     KEY idx_authenticators_user_id (user_id),
     CONSTRAINT fk_authenticators_user
       FOREIGN KEY (user_id) REFERENCES users (id)
       ON DELETE CASCADE ON UPDATE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1 AS migration_v26_authenticators_exists'
);
PREPARE v26_stmt_create_authenticators FROM @v26_sql_create_authenticators;
EXECUTE v26_stmt_create_authenticators;
DEALLOCATE PREPARE v26_stmt_create_authenticators;
