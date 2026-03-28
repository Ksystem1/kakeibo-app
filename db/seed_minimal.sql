-- 開発・結合テスト用: 先に users に1行入れてから VITE_DEV_USER_ID と一致させる
INSERT INTO users (cognito_sub, email, display_name)
VALUES (NULL, 'dev@example.com', '開発ユーザー');
