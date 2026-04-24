-- v33: users.last_accessed_at（最終アクセス時刻）
-- 実行: cd backend && npm run db:migrate-v33

SET NAMES utf8mb4;

ALTER TABLE users
  ADD COLUMN last_accessed_at DATETIME NULL COMMENT '最終アクセス（認証済みAPI利用時。15分間隔で更新）' AFTER last_login_at;

CREATE INDEX idx_users_last_accessed_at ON users(last_accessed_at);
