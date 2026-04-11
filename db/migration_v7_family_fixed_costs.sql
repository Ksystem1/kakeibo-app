-- v7: 家族単位の固定費（家族メンバー全員が共有・編集可）
-- RDS で実行: mysql ... < db/migration_v7_family_fixed_costs.sql

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS family_fixed_cost_items (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id       BIGINT UNSIGNED NOT NULL,
  label           VARCHAR(100) NOT NULL COMMENT '表示名（UI のカテゴリ列）',
  amount          BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '円・正の整数',
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ffci_family_sort (family_id, sort_order),
  CONSTRAINT fk_ffci_family
    FOREIGN KEY (family_id) REFERENCES families (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
