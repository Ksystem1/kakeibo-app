-- v3: 管理者フラグ追加
-- users テーブルに is_admin を追加し、管理者専用機能で利用する

ALTER TABLE users
  ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0 AFTER email;

-- 例: 特定アカウントを管理者化（実運用でメールを置き換えて実行）
-- UPDATE users SET is_admin = 1 WHERE email = 'your-admin@example.com';
