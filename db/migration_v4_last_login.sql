-- v4: 最終ログイン日時（管理者ダッシュボード表示用）
-- ログイン成功時に backend が UPDATE します。

ALTER TABLE users
  ADD COLUMN last_login_at DATETIME NULL COMMENT '最終ログイン（認証成功時）' AFTER updated_at;
