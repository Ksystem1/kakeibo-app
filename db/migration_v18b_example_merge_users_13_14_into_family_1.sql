-- 例: ユーザー 13, 14 を家族 1 に統合し、子ども権限（KID）にする（ID は環境に合わせて変更）
-- 前提: migration_v18_users_family_role.sql 適用済み
-- 実行前にバックアップ推奨

START TRANSACTION;

DELETE FROM family_members WHERE user_id IN (13, 14);

INSERT INTO family_members (family_id, user_id, role) VALUES
  (1, 13, 'member'),
  (1, 14, 'member');

UPDATE users
SET default_family_id = 1,
    family_role = 'KID',
    updated_at = NOW()
WHERE id IN (13, 14);

COMMIT;
