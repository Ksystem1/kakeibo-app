-- v17: subscription_status に admin_free（管理者付与の無料プレミアム枠）を公式値として文書化
-- 列型の変更は不要（VARCHAR(32) のまま）。COMMENT のみ更新する場合に実行。
-- 適用例: mysql -h <RDS_HOST> -P 3306 -u <USER> -p <DB> < db/migration_v17_subscription_status_admin_free.sql

SET NAMES utf8mb4;

ALTER TABLE users
  MODIFY COLUMN subscription_status VARCHAR(32) NOT NULL DEFAULT 'inactive'
  COMMENT 'Stripe/admin: active trialing past_due canceled unpaid paused inactive admin_free';

-- families に列がある環境のみ（v12 済み）
SET @v17_db := DATABASE();
SET @v17_has_fam := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v17_db AND TABLE_NAME = 'families' AND COLUMN_NAME = 'subscription_status'
);
SET @v17_sql := IF(
  @v17_has_fam > 0,
  'ALTER TABLE families MODIFY COLUMN subscription_status VARCHAR(32) NOT NULL DEFAULT ''inactive'' COMMENT ''Stripe/admin: 家族単位。active trialing past_due … admin_free（管理者付与）''',
  'SELECT 1 AS migration_v17_families_subscription_status_skip'
);
PREPARE v17_stmt FROM @v17_sql;
EXECUTE v17_stmt;
DEALLOCATE PREPARE v17_stmt;
