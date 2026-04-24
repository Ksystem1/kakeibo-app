-- v31: users.email の UNIQUE 解除（管理者「ユーザー追加」で同一メールのテストユーザーを作れるようにする）
-- 一般登録 /auth/register は従来どおりアプリ側で重複を拒否。
-- 同一メールが複数行ある場合、メールでのログインは先頭1件（LIMIT 1）に一致する挙動になる点に注意。
-- RDS: mysql < db/migration_v31_drop_users_email_unique.sql または npm run db:migrate-v31

SET NAMES utf8mb4;

SET @v31_db := DATABASE();

SET @v31_idx := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @v31_db
    AND TABLE_NAME = 'users'
    AND INDEX_NAME = 'uq_users_email'
);

SET @v31_sql := IF(
  @v31_idx > 0,
  'ALTER TABLE users DROP INDEX uq_users_email',
  'SELECT 1 AS migration_v31_uq_users_email_skip'
);
PREPARE v31_stmt FROM @v31_sql;
EXECUTE v31_stmt;
DEALLOCATE PREPARE v31_stmt;

SET @v31_has_idx_email := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @v31_db
    AND TABLE_NAME = 'users'
    AND INDEX_NAME = 'idx_users_email'
);

SET @v31_add_idx := IF(
  @v31_has_idx_email = 0,
  'CREATE INDEX idx_users_email ON users (email)',
  'SELECT 1 AS migration_v31_idx_users_email_exists'
);
PREPARE v31_idx_stmt FROM @v31_add_idx;
EXECUTE v31_idx_stmt;
DEALLOCATE PREPARE v31_idx_stmt;
