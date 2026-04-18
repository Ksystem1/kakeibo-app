-- v14: サポートチャット（家族単位ルーム・メッセージ）
-- RDS で実行: mysql ... < db/migration_v14_chat_messages.sql
-- または: cd backend && npm run db:migrate-v14

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS chat_messages (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id       BIGINT UNSIGNED NOT NULL COMMENT 'チャットルーム＝家族単位',
  sender_user_id  BIGINT UNSIGNED NOT NULL COMMENT '送信者ユーザーID',
  body            TEXT NOT NULL COMMENT '本文',
  is_staff        TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=管理者として送信',
  is_important    TINYINT(1) NOT NULL DEFAULT 0 COMMENT '重要（メモ用・管理者が後から抽出）',
  deleted_at      DATETIME NULL COMMENT '管理者による削除（論理削除）',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '送信日時',
  PRIMARY KEY (id),
  KEY idx_cm_family_created (family_id, created_at),
  KEY idx_cm_family_id (family_id, id),
  CONSTRAINT fk_cm_family FOREIGN KEY (family_id) REFERENCES families (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_cm_sender FOREIGN KEY (sender_user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
