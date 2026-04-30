-- v44: users.last_access_user_agent（管理画面「接続」列用。認証APIアクセス時に15分間隔で更新）
-- 実行: cd backend && npm run db:migrate-v44

SET NAMES utf8mb4;

ALTER TABLE users
  ADD COLUMN last_access_user_agent VARCHAR(512) NULL COMMENT '最終アクセス時の User-Agent（先頭512文字）' AFTER last_accessed_at;
