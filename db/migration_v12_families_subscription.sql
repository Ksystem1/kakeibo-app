-- v12: サブスク・Stripe を家族単位（families テーブル）に集約
-- 適用: cd backend && npm run db:migrate-v12
-- 前提: families テーブル（v2）、users の v8〜v11 列はレガシーとして残る
-- 再実行: 各列が既にあればスキップ（冪等）

SET NAMES utf8mb4;

SET @v12_db := DATABASE();

-- subscription_status
SET @v12a := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v12_db AND TABLE_NAME = 'families' AND COLUMN_NAME = 'subscription_status'
);
SET @v12a_sql := IF(
  @v12a = 0,
  'ALTER TABLE families ADD COLUMN subscription_status VARCHAR(32) NOT NULL DEFAULT ''inactive'' COMMENT ''Stripe/admin: 家族単位。active trialing past_due canceled ...''',
  'SELECT 1 AS migration_v12_sub_status_skip'
);
PREPARE v12a_stmt FROM @v12a_sql;
EXECUTE v12a_stmt;
DEALLOCATE PREPARE v12a_stmt;

-- stripe_customer_id
SET @v12b := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v12_db AND TABLE_NAME = 'families' AND COLUMN_NAME = 'stripe_customer_id'
);
SET @v12b_sql := IF(
  @v12b = 0,
  'ALTER TABLE families ADD COLUMN stripe_customer_id VARCHAR(255) NULL COMMENT ''Stripe Customer id (cus_...)，家族単位''',
  'SELECT 1 AS migration_v12_cus_skip'
);
PREPARE v12b_stmt FROM @v12b_sql;
EXECUTE v12b_stmt;
DEALLOCATE PREPARE v12b_stmt;

-- stripe_subscription_id
SET @v12c := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v12_db AND TABLE_NAME = 'families' AND COLUMN_NAME = 'stripe_subscription_id'
);
SET @v12c_sql := IF(
  @v12c = 0,
  'ALTER TABLE families ADD COLUMN stripe_subscription_id VARCHAR(255) NULL COMMENT ''Stripe Subscription id (sub_...)，家族単位''',
  'SELECT 1 AS migration_v12_sub_id_skip'
);
PREPARE v12c_stmt FROM @v12c_sql;
EXECUTE v12c_stmt;
DEALLOCATE PREPARE v12c_stmt;

-- subscription_period_end_at
SET @v12d := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v12_db AND TABLE_NAME = 'families' AND COLUMN_NAME = 'subscription_period_end_at'
);
SET @v12d_sql := IF(
  @v12d = 0,
  'ALTER TABLE families ADD COLUMN subscription_period_end_at DATETIME NULL COMMENT ''Stripe current_period_end，家族単位''',
  'SELECT 1 AS migration_v12_period_skip'
);
PREPARE v12d_stmt FROM @v12d_sql;
EXECUTE v12d_stmt;
DEALLOCATE PREPARE v12d_stmt;

-- subscription_cancel_at_period_end
SET @v12e := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v12_db AND TABLE_NAME = 'families' AND COLUMN_NAME = 'subscription_cancel_at_period_end'
);
SET @v12e_sql := IF(
  @v12e = 0,
  'ALTER TABLE families ADD COLUMN subscription_cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''Stripe cancel_at_period_end，家族単位''',
  'SELECT 1 AS migration_v12_cancel_flag_skip'
);
PREPARE v12e_stmt FROM @v12e_sql;
EXECUTE v12e_stmt;
DEALLOCATE PREPARE v12e_stmt;

-- インデックス（Webhook 突合用）
SET @v12f := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @v12_db AND TABLE_NAME = 'families' AND INDEX_NAME = 'idx_families_stripe_customer_id'
);
SET @v12f_sql := IF(
  @v12f = 0,
  'CREATE INDEX idx_families_stripe_customer_id ON families (stripe_customer_id)',
  'SELECT 1 AS migration_v12_idx_skip'
);
PREPARE v12f_stmt FROM @v12f_sql;
EXECUTE v12f_stmt;
DEALLOCATE PREPARE v12f_stmt;
