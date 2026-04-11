-- v9（任意）: is_premium フラグ — subscription_status と併用可
-- 前提: v8 適用済みで users.subscription_status 列が存在すること。
-- is_premium=1 のユーザーは subscription_status に関わらず有料（active）扱い。
-- v8 のみで十分な場合はこのマイグレはスキップしてよい。
--
-- RDS: mysql ... < db/migration_v9_users_is_premium.sql

SET NAMES utf8mb4;

ALTER TABLE users
  ADD COLUMN is_premium TINYINT(1) NOT NULL DEFAULT 0
  COMMENT '1=プレミアム扱い（レシートAI有料プロンプト等）。Stripe連携後は subscription_status と同期推奨'
  AFTER subscription_status;
