-- v39: ナビスキン廃止に伴い users/families のスキン選択カラムを削除
-- 実行: cd backend && npm run db:migrate-v39

SET NAMES utf8mb4;

-- users.selected_skin_id
SET @drop_users_selected_skin_id = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'users'
        AND COLUMN_NAME = 'selected_skin_id'
    ),
    'ALTER TABLE users DROP COLUMN selected_skin_id',
    'SELECT 1'
  )
);
PREPARE stmt FROM @drop_users_selected_skin_id;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- users.nav_skin_id
SET @drop_users_nav_skin_id = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'users'
        AND COLUMN_NAME = 'nav_skin_id'
    ),
    'ALTER TABLE users DROP COLUMN nav_skin_id',
    'SELECT 1'
  )
);
PREPARE stmt FROM @drop_users_nav_skin_id;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- users.skin_id
SET @drop_users_skin_id = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'users'
        AND COLUMN_NAME = 'skin_id'
    ),
    'ALTER TABLE users DROP COLUMN skin_id',
    'SELECT 1'
  )
);
PREPARE stmt FROM @drop_users_skin_id;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- families.selected_skin_id
SET @drop_families_selected_skin_id = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'families'
        AND COLUMN_NAME = 'selected_skin_id'
    ),
    'ALTER TABLE families DROP COLUMN selected_skin_id',
    'SELECT 1'
  )
);
PREPARE stmt FROM @drop_families_selected_skin_id;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- families.nav_skin_id
SET @drop_families_nav_skin_id = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'families'
        AND COLUMN_NAME = 'nav_skin_id'
    ),
    'ALTER TABLE families DROP COLUMN nav_skin_id',
    'SELECT 1'
  )
);
PREPARE stmt FROM @drop_families_nav_skin_id;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
