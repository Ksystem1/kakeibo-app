-- レシート店名（OCR 生）キーに対する名寄せキャッシュ（ユーザー別・v42 で Bedrock 前提のコメントを整理）
-- 実行: cd backend && npm run db:migrate-v40
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS user_store_places (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id               BIGINT UNSIGNED NOT NULL,
  ocr_vendor_key        CHAR(64) NOT NULL COMMENT '正規化した店名文字列の SHA256 hex',
  place_id              VARCHAR(256) NULL,
  display_name          VARCHAR(500) NULL,
  formatted_address     VARCHAR(1000) NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_store_place (user_id, ocr_vendor_key),
  KEY idx_user_store_places_user (user_id),
  CONSTRAINT fk_user_store_places_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
