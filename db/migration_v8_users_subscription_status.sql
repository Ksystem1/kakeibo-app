-- v8: サブスクリプション状態（レシート AI の精度ティア等に使用）
-- RDS: mysql ... < db/migration_v8_users_subscription_status.sql

SET NAMES utf8mb4;

ALTER TABLE users
  ADD COLUMN subscription_status VARCHAR(32) NOT NULL DEFAULT 'inactive'
  COMMENT 'inactive | active（Stripe Webhook 等で更新）';
