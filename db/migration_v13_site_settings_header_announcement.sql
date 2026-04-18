-- ヘッダーお知らせ（全ユーザー向け・管理者が編集）
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS site_settings (
  id                   TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  header_announcement  VARCHAR(512) NOT NULL DEFAULT '' COMMENT 'ヘッダー1行お知らせ（プレーンテキスト）',
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO site_settings (id, header_announcement) VALUES (1, '');
