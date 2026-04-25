-- v36: Standard / Premium の機能切り分けを厳格化
-- 実行: cd backend && npm run db:migrate-v36

SET NAMES utf8mb4;

INSERT INTO feature_permissions (feature_key, min_plan, label_ja, sort_order) VALUES
  ('receipt_ai', 'standard', 'レシートAI', 10),
  ('nav_skins_premium', 'premium', 'プレミアムナビスキン', 20),
  ('export_csv', 'premium', 'CSV取込・エクスポート', 30),
  ('support_chat', 'standard', 'サポートチャット', 40),
  ('medical_deduction_csv', 'premium', '医療費控除CSV（集計の書き出し）', 50)
ON DUPLICATE KEY UPDATE
  min_plan = VALUES(min_plan),
  label_ja = VALUES(label_ja),
  sort_order = VALUES(sort_order);
