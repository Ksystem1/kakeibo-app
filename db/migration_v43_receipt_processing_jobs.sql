-- v43: 非同期レシート解析ジョブ（202 Accepted + ポーリング）
-- 本番: RDS 上で手動または CI 前提で実行。ローカルは backend の npm スクリプトから可。

CREATE TABLE IF NOT EXISTS receipt_processing_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id CHAR(36) NOT NULL COMMENT 'クライアント向けUUID',
  user_id BIGINT UNSIGNED NOT NULL,
  status ENUM('pending', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  request_json LONGTEXT NOT NULL COMMENT 'POST 時の { imageBase64, debugForceReceiptTier? }',
  result_data JSON NULL COMMENT 'POST /receipts/parse と同形の 200 応答JSON',
  error_message TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_receipt_job_id (job_id),
  KEY idx_receipt_job_user (user_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
