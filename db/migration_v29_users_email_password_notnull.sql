-- v29: 空メールの仮割当（以降の NOT NULL 化は backend/scripts/run-migration-v29.mjs で password 埋め後に実行）
SET NAMES utf8mb4;

UPDATE users
SET email = CONCAT('legacy-nomail-', id, '@users.kakeibo.internal')
WHERE email IS NULL OR TRIM(COALESCE(email, '')) = '';
