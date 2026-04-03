-- 本番 RDS 等で実行: 指定メールのユーザーを管理者にする
-- （UI の「管理者」バッジ・「管理」は users.is_admin = 1 が必須）

UPDATE users
SET is_admin = 1
WHERE LOWER(email) = LOWER('script_00123@yahoo.co.jp');

SELECT id, email, login_name, is_admin
FROM users
WHERE LOWER(email) = LOWER('script_00123@yahoo.co.jp');
