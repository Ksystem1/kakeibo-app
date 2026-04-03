-- 本番 RDS 等で実行: 指定ログイン名のユーザーを管理者にする
-- （UI の「管理者」バッジ・「管理」は users.is_admin = 1 が必須）

UPDATE users
SET is_admin = 1
WHERE LOWER(login_name) = LOWER('YAMA');

SELECT id, email, login_name, is_admin
FROM users
WHERE LOWER(login_name) = LOWER('YAMA');
