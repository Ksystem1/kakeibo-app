-- v35: 機能権限に医療費控除CSV（医療費集計のエクスポート）を追加
-- 実行: cd backend && npm run db:migrate-v35

SET NAMES utf8mb4;

INSERT INTO feature_permissions (feature_key, min_plan, label_ja, sort_order) VALUES
  ('medical_deduction_csv', 'standard', '医療費控除CSV（集計の書き出し）', 50)
ON DUPLICATE KEY UPDATE
  label_ja = VALUES(label_ja),
  sort_order = VALUES(sort_order);
