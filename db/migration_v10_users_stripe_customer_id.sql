-- v10: Stripe Customer ID（Webhook で users を特定するため）
-- 適用: cd backend && npm run db:migrate-v10
-- 再実行: 列が既にあればスキップ（冪等）

SET NAMES utf8mb4;

SET @v10_db := DATABASE();
SET @v10_col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v10_db
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'stripe_customer_id'
);

SET @v10_sql := IF(
  @v10_col_exists = 0,
  'ALTER TABLE users ADD COLUMN stripe_customer_id VARCHAR(255) NULL COMMENT ''Stripe Customer id (cus_...)''',
  'SELECT 1 AS migration_v10_stripe_customer_id_already_applied'
);

PREPARE v10_stmt FROM @v10_sql;
EXECUTE v10_stmt;
DEALLOCATE PREPARE v10_stmt;

SET @v10_idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @v10_db
    AND TABLE_NAME = 'users'
    AND INDEX_NAME = 'idx_users_stripe_customer_id'
);

SET @v10_idx_sql := IF(
  @v10_idx_exists = 0,
  'CREATE INDEX idx_users_stripe_customer_id ON users (stripe_customer_id)',
  'SELECT 1 AS migration_v10_stripe_idx_skip'
);

PREPARE v10_idx FROM @v10_idx_sql;
EXECUTE v10_idx;
DEALLOCATE PREPARE v10_idx;
