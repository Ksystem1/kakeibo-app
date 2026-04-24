-- v32: プラン別機能権限（Standard / Premium）
-- 実行: cd backend && npm run db:migrate-v32

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS feature_permissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  feature_key VARCHAR(64) NOT NULL COMMENT '英小文字・数字・アンダースコア',
  min_plan ENUM('standard', 'premium') NOT NULL DEFAULT 'standard' COMMENT '利用に必要な最小プラン',
  label_ja VARCHAR(128) NULL COMMENT '管理画面表示用',
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_feature_permissions_key (feature_key),
  KEY idx_feature_permissions_sort (sort_order, feature_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO feature_permissions (feature_key, min_plan, label_ja, sort_order) VALUES
  ('receipt_ai', 'premium', 'レシートAI', 10),
  ('nav_skins_premium', 'premium', 'プレミアムナビスキン', 20),
  ('export_csv', 'standard', 'CSV取込・エクスポート', 30),
  ('support_chat', 'standard', 'サポートチャット', 40)
ON DUPLICATE KEY UPDATE
  label_ja = VALUES(label_ja),
  sort_order = VALUES(sort_order);
