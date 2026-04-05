-- レシート OCR 取込データとユーザー補正（カテゴリ・メモ）の対応を保持する
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS receipt_ocr_corrections (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id             BIGINT UNSIGNED NOT NULL,
  family_id           BIGINT UNSIGNED NULL,
  match_key           CHAR(64) NOT NULL COMMENT '正規化した取込内容の SHA256(hex)',
  ocr_snapshot_json   LONGTEXT NULL COMMENT '取込時の summary/items JSON',
  category_id         BIGINT UNSIGNED NULL,
  memo                VARCHAR(500) NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_receipt_ocr_corr_user_match (user_id, match_key),
  KEY idx_receipt_ocr_corr_user (user_id),
  CONSTRAINT fk_receipt_ocr_corr_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_receipt_ocr_corr_category
    FOREIGN KEY (category_id) REFERENCES categories (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
