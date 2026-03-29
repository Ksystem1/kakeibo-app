-- v2: 認証（メールまたは login_name + パスワード）、家族、取引の family スコープ
-- 実行前にバックアップ。既に列がある場合は該当 ALTER をスキップしてください。

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ユーザー（列が既にある場合はエラーになるのでスキップ）
ALTER TABLE users
  ADD COLUMN login_name VARCHAR(64) NULL COMMENT 'ログインID（任意。未設定はメールでログイン）' AFTER email;

ALTER TABLE users
  ADD COLUMN password_hash VARCHAR(255) NULL COMMENT 'bcrypt' AFTER login_name;

ALTER TABLE users
  ADD COLUMN default_family_id BIGINT UNSIGNED NULL AFTER password_hash;

CREATE UNIQUE INDEX uq_users_login_name ON users (login_name);

CREATE TABLE IF NOT EXISTS families (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(100) NOT NULL DEFAULT 'マイ家族',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS family_members (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id       BIGINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL,
  role            ENUM('owner','member') NOT NULL DEFAULT 'member',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_family_user (family_id, user_id),
  KEY idx_fm_user (user_id),
  CONSTRAINT fk_fm_family FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE CASCADE,
  CONSTRAINT fk_fm_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  token_hash      CHAR(64) NOT NULL,
  expires_at      DATETIME NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_prt_user (user_id),
  KEY idx_prt_expires (expires_at),
  CONSTRAINT fk_prt_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 将来の家族招待（メールリンク用）
CREATE TABLE IF NOT EXISTS family_invites (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id       BIGINT UNSIGNED NOT NULL,
  email           VARCHAR(255) NOT NULL,
  token_hash      CHAR(64) NOT NULL,
  expires_at      DATETIME NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_fi_family (family_id),
  CONSTRAINT fk_fi_family FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE users
  ADD CONSTRAINT fk_users_default_family FOREIGN KEY (default_family_id) REFERENCES families (id) ON DELETE SET NULL;

ALTER TABLE categories
  ADD COLUMN family_id BIGINT UNSIGNED NULL AFTER user_id,
  ADD KEY idx_categories_family (family_id),
  ADD CONSTRAINT fk_categories_family FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE CASCADE;

ALTER TABLE transactions
  ADD COLUMN family_id BIGINT UNSIGNED NULL AFTER user_id,
  ADD KEY idx_tx_family_date (family_id, transaction_date),
  ADD CONSTRAINT fk_transactions_family FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE CASCADE;

SET FOREIGN_KEY_CHECKS = 1;
