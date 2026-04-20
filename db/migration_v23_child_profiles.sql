-- v23: users に子供サブプロファイル用の列を追加
-- - is_child: 子供フラグ
-- - parent_id: 親ユーザーID（users.id）
-- - grade_group: 学年グループ（1-2 / 3-4 / 5-6）
-- 併せて email / password_hash を NULL 許容にする（子供プロフィールは認証情報不要）

SET NAMES utf8mb4;

SET @v23_db := DATABASE();

SET @v23_has_email := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v23_db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email'
);
SET @v23_has_password_hash := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v23_db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'password_hash'
);
SET @v23_has_is_child := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v23_db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_child'
);
SET @v23_has_parent_id := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v23_db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'parent_id'
);
SET @v23_has_grade_group := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @v23_db AND TABLE_NAME = 'users' AND COLUMN_NAME = 'grade_group'
);
SET @v23_has_parent_idx := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @v23_db AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_parent_id'
);
SET @v23_has_parent_fk := (
  SELECT COUNT(*)
  FROM information_schema.REFERENTIAL_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @v23_db
    AND TABLE_NAME = 'users'
    AND CONSTRAINT_NAME = 'fk_users_parent'
);

SET @v23_sql_email := IF(
  @v23_has_email = 1,
  'ALTER TABLE users MODIFY COLUMN email VARCHAR(255) NULL',
  'SELECT 1 AS migration_v23_email_missing_skip'
);
PREPARE v23_stmt_email FROM @v23_sql_email;
EXECUTE v23_stmt_email;
DEALLOCATE PREPARE v23_stmt_email;

SET @v23_sql_password := IF(
  @v23_has_password_hash = 1,
  'ALTER TABLE users MODIFY COLUMN password_hash VARCHAR(255) NULL',
  'SELECT 1 AS migration_v23_password_hash_missing_skip'
);
PREPARE v23_stmt_password FROM @v23_sql_password;
EXECUTE v23_stmt_password;
DEALLOCATE PREPARE v23_stmt_password;

SET @v23_sql_is_child := IF(
  @v23_has_is_child = 0,
  'ALTER TABLE users ADD COLUMN is_child TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''子供サブプロファイル（1=true）'' AFTER display_name',
  'SELECT 1 AS migration_v23_is_child_skip'
);
PREPARE v23_stmt_is_child FROM @v23_sql_is_child;
EXECUTE v23_stmt_is_child;
DEALLOCATE PREPARE v23_stmt_is_child;

SET @v23_sql_parent := IF(
  @v23_has_parent_id = 0,
  'ALTER TABLE users ADD COLUMN parent_id BIGINT UNSIGNED NULL COMMENT ''親ユーザーID（users.id）'' AFTER is_child',
  'SELECT 1 AS migration_v23_parent_id_skip'
);
PREPARE v23_stmt_parent FROM @v23_sql_parent;
EXECUTE v23_stmt_parent;
DEALLOCATE PREPARE v23_stmt_parent;

SET @v23_sql_grade := IF(
  @v23_has_grade_group = 0,
  'ALTER TABLE users ADD COLUMN grade_group ENUM(''1-2'', ''3-4'', ''5-6'') NULL COMMENT ''学年グループ'' AFTER parent_id',
  'SELECT 1 AS migration_v23_grade_group_skip'
);
PREPARE v23_stmt_grade FROM @v23_sql_grade;
EXECUTE v23_stmt_grade;
DEALLOCATE PREPARE v23_stmt_grade;

SET @v23_sql_parent_idx := IF(
  @v23_has_parent_idx = 0,
  'ALTER TABLE users ADD INDEX idx_users_parent_id (parent_id)',
  'SELECT 1 AS migration_v23_parent_index_skip'
);
PREPARE v23_stmt_parent_idx FROM @v23_sql_parent_idx;
EXECUTE v23_stmt_parent_idx;
DEALLOCATE PREPARE v23_stmt_parent_idx;

SET @v23_sql_parent_fk := IF(
  @v23_has_parent_fk = 0,
  'ALTER TABLE users ADD CONSTRAINT fk_users_parent FOREIGN KEY (parent_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1 AS migration_v23_parent_fk_skip'
);
PREPARE v23_stmt_parent_fk FROM @v23_sql_parent_fk;
EXECUTE v23_stmt_parent_fk;
DEALLOCATE PREPARE v23_stmt_parent_fk;
