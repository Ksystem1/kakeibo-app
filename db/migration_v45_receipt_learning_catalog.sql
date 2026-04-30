-- v45: receipt_learning_catalog（匿名・重複排除済みのレシート学習カタログ）
-- 実行: cd backend && npm run db:migrate-v45

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS receipt_learning_catalog (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  fingerprint CHAR(64) NOT NULL COMMENT 'SHA-256 hex（vendor_norm + year_month + total_amount + item_tokens）',
  vendor_norm VARCHAR(191) NOT NULL COMMENT '正規化店名（個人情報を含まない）',
  vendor_label VARCHAR(120) NULL COMMENT '表示用店名（短い代表名）',
  year_month CHAR(7) NOT NULL DEFAULT '0000-00' COMMENT 'YYYY-MM（不明時 0000-00）',
  total_amount INT NULL COMMENT '確定合計（円）',
  item_tokens VARCHAR(255) NULL COMMENT '明細名から抽出した代表トークン（先頭数件）',
  category_name_hint VARCHAR(100) NULL COMMENT '学習されたカテゴリ名ヒント（IDではなく名称で保持）',
  sample_count INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '同一 fingerprint の学習回数',
  is_disabled TINYINT(1) NOT NULL DEFAULT 0 COMMENT '管理者が無効化した行',
  admin_note VARCHAR(255) NULL COMMENT '管理者メモ',
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_receipt_learning_catalog_fp (fingerprint),
  KEY idx_receipt_learning_vendor_ym (vendor_norm, year_month, is_disabled),
  KEY idx_receipt_learning_last_seen (last_seen_at),
  KEY idx_receipt_learning_category_hint (category_name_hint)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

