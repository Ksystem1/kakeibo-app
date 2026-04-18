-- 匿名化されたレシート合計の集計辞書（プレミアム解析時の参照用）
-- 生の明細名・メモ本文は保存しない。layout_fingerprint は正規化店名＋年月のみの SHA-256。
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS global_receipt_ocr_corrections (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  layout_fingerprint   CHAR(64) NOT NULL COMMENT 'SHA-256 hex（正規化 vendor + YYYY-MM）',
  suggested_total      INT NOT NULL COMMENT '利用者が確定した税込合計（円）。商品名は保持しない',
  hit_count            INT UNSIGNED NOT NULL DEFAULT 1,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_global_receipt_fp_total (layout_fingerprint, suggested_total),
  KEY idx_global_receipt_fp (layout_fingerprint)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
