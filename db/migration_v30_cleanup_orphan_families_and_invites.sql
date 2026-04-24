-- v30: 孤児家族（メンバー0・default_family_id からも参照されない）の削除、期限切れ招待の削除
-- 退会・削除まわりの掃除。RDS: mysql ... < または npm run db:migrate-v30

SET NAMES utf8mb4;

DELETE f
FROM families f
WHERE NOT EXISTS (SELECT 1 FROM family_members m WHERE m.family_id = f.id)
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.default_family_id = f.id);
