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
  email           VARCHAR(255) NULL,
  auth_method     ENUM('email','passkey','both') NOT NULL DEFAULT 'email' COMMENT '認証方式: email/passkey/both',
  recovery_code_hash CHAR(64) NULL COMMENT 'リカバリーコードのSHA-256',
  recovery_code_issued_at DATETIME NULL COMMENT 'リカバリーコード発行日時',
  recovery_code_used_at DATETIME NULL COMMENT 'リカバリーコード使用日時',
  is_admin        TINYINT(1) NOT NULL DEFAULT 0 COMMENT '管理者フラグ（1=true）',
  subscription_status VARCHAR(32) NOT NULL DEFAULT 'inactive' COMMENT 'Stripe/admin: active trialing past_due canceled unpaid paused inactive admin_free',
  stripe_customer_id VARCHAR(255) NULL COMMENT 'Stripe Customer id (cus_...) Webhook 突合',
  stripe_subscription_id VARCHAR(255) NULL COMMENT 'Stripe Subscription id (sub_...)',
  subscription_period_end_at DATETIME NULL COMMENT 'Stripe current_period_end UTC 請求サイクル終了',
  subscription_cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Stripe cancel_at_period_end',
  is_premium      TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=プレミアム（任意。active と併用可）',
  display_name    VARCHAR(100) NULL,
  is_child        TINYINT(1) NOT NULL DEFAULT 0 COMMENT '子供サブプロファイル（1=true）',
  parent_id       BIGINT UNSIGNED NULL COMMENT '親ユーザーID（users.id）',
  grade_group     ENUM('1-2','3-4','5-6') NULL COMMENT '学年グループ',
  timezone        VARCHAR(64) NOT NULL DEFAULT 'Asia/Tokyo',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_login_at   DATETIME NULL COMMENT '最終ログイン（認証成功時）',
  last_accessed_at DATETIME NULL COMMENT '最終アクセス（認証済みAPI利用時。15分間隔で更新）',
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_cognito_sub (cognito_sub),
  KEY idx_users_email (email),
  KEY idx_users_parent_id (parent_id),
  KEY idx_users_stripe_customer_id (stripe_customer_id),
  KEY idx_users_last_accessed_at (last_accessed_at),
  KEY idx_users_created_at (created_at),
  CONSTRAINT fk_users_parent
    FOREIGN KEY (parent_id) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- WebAuthn / Passkey 認証器（1ユーザー複数デバイス）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS authenticators (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  credential_id   VARCHAR(1024) NOT NULL COMMENT 'WebAuthn credentialId（base64url）',
  public_key      BLOB NOT NULL COMMENT 'COSE public key',
  counter         BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '署名カウンタ',
  transports      VARCHAR(255) NULL COMMENT 'usb,nfc,ble,internal など（CSV）',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_authenticators_credential_id (credential_id(255)),
  KEY idx_authenticators_user (user_id),
  CONSTRAINT fk_authenticators_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
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
  is_medical_default TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'カテゴリ選択時に医療費控除明細として初期化するか',
  default_medical_type ENUM('treatment','medicine','other') NULL COMMENT 'カテゴリ既定の医療費区分（3区分）',
  default_patient_name VARCHAR(120) NULL COMMENT 'カテゴリ既定の対象者名',
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
  amount           DECIMAL(19, 4) NOT NULL COMMENT 'JPY。0 円可（収入）。支出はアプリ/API で正の数のみ',
  transaction_date DATE NOT NULL,
  memo             VARCHAR(500) NULL,
  is_medical_expense TINYINT(1) NOT NULL DEFAULT 0 COMMENT '医療費控除対象か',
  medical_type     ENUM('treatment','medicine','other') NULL COMMENT '医療費控除の3区分',
  medical_patient_name VARCHAR(120) NULL COMMENT '医療費対象者名',
  external_id      VARCHAR(64) NULL COMMENT '連携元IDなど（冪等用）',
  external_transaction_id VARCHAR(255) NULL COMMENT '外部取引ID（PayPay等の取引番号。文字列で保持）',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_transactions_user_external (user_id, external_id),
  UNIQUE KEY uq_transactions_user_external_txid (user_id, external_transaction_id),
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
  CONSTRAINT chk_transactions_amount_nonneg CHECK (amount >= 0)
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

-- ---------------------------------------------------------------------------
-- レシート OCR 取込とユーザー補正（学習用）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS receipt_ocr_corrections (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id             BIGINT UNSIGNED NOT NULL,
  family_id           BIGINT UNSIGNED NULL,
  match_key           CHAR(64) NOT NULL COMMENT '正規化した取込内容の SHA256(hex)',
  ocr_snapshot_json   LONGTEXT NULL COMMENT '取込時の summary/items JSON',
  category_id         BIGINT UNSIGNED NULL,
  memo                VARCHAR(500) NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_receipt_ocr_corr_user_match (user_id, match_key),
  KEY idx_receipt_ocr_corr_user (user_id),
  CONSTRAINT fk_receipt_ocr_corr_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_receipt_ocr_corr_category
    FOREIGN KEY (category_id) REFERENCES categories (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 匿名化レシート合計のグローバル集計（プレミアム解析の候補用）。migration_v15 と同等。
CREATE TABLE IF NOT EXISTS global_receipt_ocr_corrections (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  layout_fingerprint   CHAR(64) NOT NULL COMMENT 'SHA-256 hex（正規化 vendor + YYYY-MM）',
  suggested_total      INT NOT NULL COMMENT '確定合計（円）。商品名・メモは保持しない',
  hit_count            INT UNSIGNED NOT NULL DEFAULT 1,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_global_receipt_fp_total (layout_fingerprint, suggested_total),
  KEY idx_global_receipt_fp (layout_fingerprint)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- チェーン店名（正規化）→ 代表的な支出カテゴリ名（初期シード約1万件）。migration_v16 と同等。
CREATE TABLE IF NOT EXISTS static_chain_store_category_hints (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vendor_norm VARCHAR(191) NOT NULL COMMENT 'normalizeVendorName 相当（OCR 店名の先頭一致に使用）',
  category_name_hint VARCHAR(64) NOT NULL COMMENT 'ユーザー家計簿のカテゴリ名に寄せたヒント',
  weight INT NOT NULL DEFAULT 0 COMMENT '複数候補時の優先度（大きいほど優先）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_static_chain_vendor_norm (vendor_norm),
  KEY idx_static_chain_vendor_norm (vendor_norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 家族共通の固定費（GET/PUT /settings/fixed-costs）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS family_fixed_cost_items (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id       BIGINT UNSIGNED NOT NULL,
  label           VARCHAR(100) NOT NULL COMMENT '表示名',
  amount          BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '円',
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ffci_family_sort (family_id, sort_order),
  CONSTRAINT fk_ffci_family
    FOREIGN KEY (family_id) REFERENCES families (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- サイト共通設定（ヘッダーお知らせなど）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_settings (
  id                   TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  header_announcement  VARCHAR(512) NOT NULL DEFAULT '' COMMENT 'ヘッダー1行お知らせ（プレーンテキスト）',
  monitor_recruitment_enabled TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'モニター募集表示フラグ（1=表示）',
  monitor_recruitment_text VARCHAR(512) NOT NULL DEFAULT '' COMMENT 'モニター募集案内文（管理者設定）',
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- モニターログ（管理者向け分析: CSV取込サマリ）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monitor_logs (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  log_type         VARCHAR(64) NOT NULL COMMENT 'paypay_import など',
  user_id          BIGINT UNSIGNED NULL,
  import_target    VARCHAR(64) NULL COMMENT 'paypay_csv など',
  action_type      VARCHAR(32) NULL COMMENT 'preview / commit',
  total_rows       INT UNSIGNED NOT NULL DEFAULT 0,
  new_count        INT UNSIGNED NOT NULL DEFAULT 0,
  updated_count    INT UNSIGNED NOT NULL DEFAULT 0,
  aggregated_count INT UNSIGNED NOT NULL DEFAULT 0,
  excluded_count   INT UNSIGNED NOT NULL DEFAULT 0,
  error_count      INT UNSIGNED NOT NULL DEFAULT 0,
  detail_json      LONGTEXT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_monitor_logs_type_created (log_type, created_at),
  KEY idx_monitor_logs_user_created (user_id, created_at),
  CONSTRAINT fk_monitor_logs_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- プラン別機能権限（Standard / Premium）
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Stripe 売上ログ（税理士向け収支レポートの元データ）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stripe_event_id VARCHAR(255) NOT NULL COMMENT 'Stripe webhook event id (evt_...)',
  stripe_source_type ENUM('checkout_session','invoice','payment_intent') NOT NULL DEFAULT 'checkout_session',
  stripe_source_id VARCHAR(255) NOT NULL COMMENT 'source object id (cs_/in_/pi_)',
  user_id BIGINT UNSIGNED NULL COMMENT 'metadata または customer 紐付けから解決したユーザー',
  family_id BIGINT UNSIGNED NULL COMMENT '課金対象の家族ID',
  currency CHAR(3) NOT NULL DEFAULT 'jpy',
  gross_amount DECIMAL(19,4) NOT NULL DEFAULT 0.0000 COMMENT '売上総額',
  stripe_fee_amount DECIMAL(19,4) NOT NULL DEFAULT 0.0000 COMMENT 'Stripe手数料',
  net_amount DECIMAL(19,4) NOT NULL DEFAULT 0.0000 COMMENT '純利益=gross-fee',
  occurred_at DATETIME NOT NULL COMMENT '決済確定時刻（Stripe由来）',
  raw_payload_json LONGTEXT NULL COMMENT '監査用の最小Stripe payload',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_logs_source (stripe_source_type, stripe_source_id),
  KEY idx_sales_logs_user_occurred (user_id, occurred_at),
  KEY idx_sales_logs_family_occurred (family_id, occurred_at),
  KEY idx_sales_logs_event (stripe_event_id),
  CONSTRAINT fk_sales_logs_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_sales_logs_family
    FOREIGN KEY (family_id) REFERENCES families (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
