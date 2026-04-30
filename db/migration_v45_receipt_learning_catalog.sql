-- v45: receipt_learning_catalog (deduplicated receipt learning catalog)
-- 実行: cd backend && npm run db:migrate-v45

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS receipt_learning_catalog (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  fingerprint CHAR(64) NOT NULL COMMENT 'sha256(vendor_norm+item_tokens+category_name_hint)',
  vendor_norm VARCHAR(191) NOT NULL COMMENT 'normalized vendor key',
  vendor_label VARCHAR(120) NULL COMMENT 'display vendor label',
  `year_month` CHAR(7) NOT NULL DEFAULT '0000-00' COMMENT 'yyyy-mm',
  total_amount INT NULL COMMENT 'confirmed total amount in JPY',
  item_tokens VARCHAR(255) NULL COMMENT 'top item tokens',
  category_name_hint VARCHAR(100) NULL COMMENT 'learned category name hint',
  sample_count INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'deduplicated sample count',
  is_disabled TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'admin disabled flag',
  admin_note VARCHAR(255) NULL COMMENT 'admin note',
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_receipt_learning_catalog_fp (fingerprint),
  KEY idx_receipt_learning_vendor_ym (vendor_norm, `year_month`, is_disabled),
  KEY idx_receipt_learning_last_seen (last_seen_at),
  KEY idx_receipt_learning_category_hint (category_name_hint)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

