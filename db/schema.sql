-- Kakeibo / 家計簿アプリ — AWS RDS for MySQL 向けスキーマ
-- Charset: utf8mb4（絵文字・日本語対応）

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- ユーザー（Cognito の sub と突き合わせる想定。未連携時は cognito_sub は NULL 可）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cognito_sub     CHAR(36) NULL COMMENT 'Cognito Username (sub) — UNIQUE 制約は下記',
  email           VARCHAR(255) NOT NULL,
  is_admin        TINYINT(1) NOT NULL DEFAULT 0 COMMENT '管理者フラグ（1=true）',
  display_name    VARCHAR(100) NULL,
  timezone        VARCHAR(64) NOT NULL DEFAULT 'Asia/Tokyo',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_cognito_sub (cognito_sub),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 口座・財布（任意。取引と紐づけて残高僧管理に使える）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(100) NOT NULL,
  account_type    ENUM('cash','bank','credit_card','electronic_money','other')
                  NOT NULL DEFAULT 'cash',
  currency_code   CHAR(3) NOT NULL DEFAULT 'JPY',
  initial_balance DECIMAL(19, 4) NOT NULL DEFAULT 0.0000,
  is_archived     TINYINT(1) NOT NULL DEFAULT 0,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_accounts_user (user_id, is_archived, sort_order),
  CONSTRAINT fk_accounts_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- カテゴリ（支出／収入。ユーザーごと。親カテゴリで階層可）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  parent_id       BIGINT UNSIGNED NULL,
  name            VARCHAR(100) NOT NULL,
  kind            ENUM('expense','income') NOT NULL DEFAULT 'expense',
  color_hex       CHAR(7) NULL COMMENT '#RRGGBB',
  sort_order      INT NOT NULL DEFAULT 0,
  is_archived     TINYINT(1) NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_categories_user_kind (user_id, kind, is_archived, sort_order),
  KEY idx_categories_parent (parent_id),
  CONSTRAINT fk_categories_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_categories_parent
    FOREIGN KEY (parent_id) REFERENCES categories (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 取引履歴
-- amount: 収入はプラス、支出はマイナスで統一するか、kind と正の値の組み合わせでも可
-- ここでは「常に正の金額 + kind」で保持
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED NOT NULL,
  account_id       BIGINT UNSIGNED NULL,
  category_id      BIGINT UNSIGNED NULL,
  kind             ENUM('expense','income','transfer') NOT NULL DEFAULT 'expense',
  amount           DECIMAL(19, 4) NOT NULL COMMENT 'JPY 想定。通貨単位は POSITIVE',
  transaction_date DATE NOT NULL,
  memo             VARCHAR(500) NULL,
  external_id      VARCHAR(64) NULL COMMENT '連携元IDなど（冪等用）',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_transactions_user_external (user_id, external_id),
  KEY idx_tx_user_date (user_id, transaction_date, id),
  KEY idx_tx_user_category (user_id, category_id),
  KEY idx_tx_user_account (user_id, account_id),
  CONSTRAINT fk_transactions_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_transactions_account
    FOREIGN KEY (account_id) REFERENCES accounts (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_transactions_category
    FOREIGN KEY (category_id) REFERENCES categories (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_transactions_amount_positive CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- transfer の相手口座は別テーブルで表現すると拡張しやすい（最小構成では expense/income のみ運用も可）

-- ---------------------------------------------------------------------------
-- 月次予算（カテゴリ単位。任意）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budgets (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  category_id     BIGINT UNSIGNED NOT NULL,
  `year_month`      CHAR(7) NOT NULL COMMENT 'YYYY-MM',
  amount_limit    DECIMAL(19, 4) NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_budgets_user_cat_month (user_id, category_id, `year_month`),
  KEY idx_budgets_user_month (user_id, `year_month`),
  CONSTRAINT fk_budgets_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_budgets_category
    FOREIGN KEY (category_id) REFERENCES categories (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
