-- v11: Stripe 請求期間終了・解約予定・Subscription ID（期間終了までプレミアム利用の表示用）
-- 適用: cd backend && npm run db:migrate-v11
-- 前提: v8 subscription_status, v10 stripe_customer_id 推奨
-- 再実行: 各列が既にあればスキップ（冪等）

SET NAMES utf8mb4;

SET @v11_db := DATABASE();

-- subscription_period_end_at
SET @v11a := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v11_db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'subscription_period_end_at'
);
SET @v11a_sql := IF(
  @v11a = 0,
  'ALTER TABLE users ADD COLUMN subscription_period_end_at DATETIME NULL COMMENT ''Stripe current_period_end (UTC). 請求サイクル終了まで利用可の表示用''',
  'SELECT 1 AS migration_v11_period_skip'
);
PREPARE v11a_stmt FROM @v11a_sql;
EXECUTE v11a_stmt;
DEALLOCATE PREPARE v11a_stmt;

-- subscription_cancel_at_period_end
SET @v11b := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v11_db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'subscription_cancel_at_period_end'
);
SET @v11b_sql := IF(
  @v11b = 0,
  'ALTER TABLE users ADD COLUMN subscription_cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''Stripe cancel_at_period_end''',
  'SELECT 1 AS migration_v11_cancel_flag_skip'
);
PREPARE v11b_stmt FROM @v11b_sql;
EXECUTE v11b_stmt;
DEALLOCATE PREPARE v11b_stmt;

-- stripe_subscription_id
SET @v11c := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v11_db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'stripe_subscription_id'
);
SET @v11c_sql := IF(
  @v11c = 0,
  'ALTER TABLE users ADD COLUMN stripe_subscription_id VARCHAR(255) NULL COMMENT ''Stripe Subscription id (sub_...)''',
  'SELECT 1 AS migration_v11_sub_id_skip'
);
PREPARE v11c_stmt FROM @v11c_sql;
EXECUTE v11c_stmt;
DEALLOCATE PREPARE v11c_stmt;
