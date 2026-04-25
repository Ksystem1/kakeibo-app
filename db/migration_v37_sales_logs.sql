-- v37: Stripe 売上ログ（売上・手数料・純利益）を保存
-- 実行: cd backend && npm run db:migrate-v37

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS sales_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stripe_event_id VARCHAR(255) NOT NULL COMMENT 'Stripe webhook event id (evt_...)',
  stripe_source_type ENUM('checkout_session','invoice','payment_intent') NOT NULL DEFAULT 'checkout_session',
  stripe_source_id VARCHAR(255) NOT NULL COMMENT 'source object id (cs_/in_/pi_)',
  user_id BIGINT UNSIGNED NULL COMMENT 'metadata または customer 紐付けから解決したユーザー',
  family_id BIGINT UNSIGNED NULL COMMENT '課金対象の家族ID',
  currency CHAR(3) NOT NULL DEFAULT 'jpy',
  gross_amount DECIMAL(19,4) NOT NULL DEFAULT 0.0000 COMMENT '売上総額',
  stripe_fee_amount DECIMAL(19,4) NOT NULL DEFAULT 0.0000 COMMENT 'Stripe手数料',
  net_amount DECIMAL(19,4) NOT NULL DEFAULT 0.0000 COMMENT '純利益=gross-fee',
  occurred_at DATETIME NOT NULL COMMENT '決済確定時刻（Stripe由来）',
  raw_payload_json LONGTEXT NULL COMMENT '監査用の最小Stripe payload',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_logs_source (stripe_source_type, stripe_source_id),
  KEY idx_sales_logs_user_occurred (user_id, occurred_at),
  KEY idx_sales_logs_family_occurred (family_id, occurred_at),
  KEY idx_sales_logs_event (stripe_event_id),
  CONSTRAINT fk_sales_logs_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_sales_logs_family
    FOREIGN KEY (family_id) REFERENCES families (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
