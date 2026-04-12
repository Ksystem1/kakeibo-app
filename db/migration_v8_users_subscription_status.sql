-- v8: サブスクリプション状態（レシート AI の精度ティア等に使用）
--
-- 適用方法（いずれか）:
--   A) 推奨: リポジトリルートで backend に移動し npm スクリプトを実行
--        cd backend && npm run db:migrate-v8
--        （backend/.env に RDS_HOST, RDS_USER, RDS_PASSWORD, RDS_DATABASE を設定）
--   B) mysql クライアントからファイルを流し込み
--        mysql -h <RDS_HOST> -P 3306 -u <USER> -p <RDS_DATABASE> < db/migration_v8_users_subscription_status.sql
--
-- 再実行: 列が既に存在する場合は ALTER をスキップします（冪等）。
--
-- 任意: 真偽フラグは v9（is_premium）を参照。

SET NAMES utf8mb4;

SET @v8_db := DATABASE();
SET @v8_col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v8_db
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'subscription_status'
);

SET @v8_sql := IF(
  @v8_col_exists = 0,
  'ALTER TABLE users ADD COLUMN subscription_status VARCHAR(32) NOT NULL DEFAULT ''inactive'' COMMENT ''inactive | active（Stripe Webhook 等で更新）''',
  'SELECT 1 AS migration_v8_subscription_status_already_applied'
);

PREPARE v8_stmt FROM @v8_sql;
EXECUTE v8_stmt;
DEALLOCATE PREPARE v8_stmt;
