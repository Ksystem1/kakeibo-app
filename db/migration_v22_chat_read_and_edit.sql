-- v22: チャット既読（ルーム単位）＋メッセージ編集日時
-- RDS: mysql ... < db/migration_v22_chat_read_and_edit.sql
-- または: cd backend && npm run db:migrate-v22

SET NAMES utf8mb4;

SET @v22_db = DATABASE();

SET @v22_has_edited := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v22_db AND TABLE_NAME = 'chat_messages' AND COLUMN_NAME = 'edited_at'
);

SET @v22_sql_edited := IF(
  @v22_has_edited = 0,
  'ALTER TABLE chat_messages ADD COLUMN edited_at DATETIME NULL DEFAULT NULL COMMENT ''本文を編集した日時'' AFTER created_at',
  'SELECT 1 AS migration_v22_edited_at_skip'
);
PREPARE v22_stmt FROM @v22_sql_edited;
EXECUTE v22_stmt;
DEALLOCATE PREPARE v22_stmt;

CREATE TABLE IF NOT EXISTS chat_room_read_state (
  family_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  chat_scope ENUM('support', 'family') NOT NULL COMMENT 'support=運営チャット family=家族チャット',
  last_read_message_id BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'この位置まで閲覧済み（メッセージ id）',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (family_id, user_id, chat_scope),
  KEY idx_crrs_family_scope (family_id, chat_scope),
  CONSTRAINT fk_crrs_family FOREIGN KEY (family_id) REFERENCES families (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_crrs_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
