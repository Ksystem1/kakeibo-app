-- v19: chat_messages.chat_scope（support=運営サポート / family=家族内）
-- 既存行は support 扱い。適用例: cd backend && npm run db:migrate-v19

SET NAMES utf8mb4;

SET @v19_db := DATABASE();
SET @v19_has := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v19_db AND TABLE_NAME = 'chat_messages' AND COLUMN_NAME = 'chat_scope'
);
SET @v19_sql := IF(
  @v19_has = 0,
  'ALTER TABLE chat_messages ADD COLUMN chat_scope ENUM(''support'', ''family'') NOT NULL DEFAULT ''support'' COMMENT ''support=運営 family=家族内'' AFTER is_important',
  'SELECT 1 AS migration_v19_chat_scope_skip'
);
PREPARE v19_stmt FROM @v19_sql;
EXECUTE v19_stmt;
DEALLOCATE PREPARE v19_stmt;

SET @v19_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @v19_db AND TABLE_NAME = 'chat_messages' AND INDEX_NAME = 'idx_cm_family_scope_id'
);
SET @v19_idx_sql := IF(
  @v19_idx = 0,
  'ALTER TABLE chat_messages ADD KEY idx_cm_family_scope_id (family_id, chat_scope, id)',
  'SELECT 1 AS migration_v19_idx_skip'
);
PREPARE v19_idx_stmt FROM @v19_idx_sql;
EXECUTE v19_idx_stmt;
DEALLOCATE PREPARE v19_idx_stmt;
