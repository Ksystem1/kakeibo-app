-- v24: PayPay CSV取込向け
-- 1) transactions.external_transaction_id 追加（文字列で冪等管理）
-- 2) monitor_logs 追加（管理者向け取込分析）

SET NAMES utf8mb4;

SET @v24_db := DATABASE();

SET @v24_has_ext_txid := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v24_db
    AND TABLE_NAME = 'transactions'
    AND COLUMN_NAME = 'external_transaction_id'
);

SET @v24_sql_add_ext_txid := IF(
  @v24_has_ext_txid = 0,
  'ALTER TABLE transactions ADD COLUMN external_transaction_id VARCHAR(255) NULL COMMENT ''外部取引ID（PayPay等の取引番号。文字列で保持）'' AFTER external_id',
  'SELECT 1 AS migration_v24_ext_txid_exists'
);
PREPARE v24_stmt_add_ext_txid FROM @v24_sql_add_ext_txid;
EXECUTE v24_stmt_add_ext_txid;
DEALLOCATE PREPARE v24_stmt_add_ext_txid;

SET @v24_has_ext_txid_idx := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @v24_db
    AND TABLE_NAME = 'transactions'
    AND INDEX_NAME = 'uq_transactions_user_external_txid'
);

SET @v24_sql_add_ext_txid_idx := IF(
  @v24_has_ext_txid_idx = 0,
  'ALTER TABLE transactions ADD UNIQUE KEY uq_transactions_user_external_txid (user_id, external_transaction_id)',
  'SELECT 1 AS migration_v24_ext_txid_idx_exists'
);
PREPARE v24_stmt_add_ext_txid_idx FROM @v24_sql_add_ext_txid_idx;
EXECUTE v24_stmt_add_ext_txid_idx;
DEALLOCATE PREPARE v24_stmt_add_ext_txid_idx;

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
