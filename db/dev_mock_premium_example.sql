-- 開発・Stripe 前の手動プレミアム化の例（メールは VERIFY_LOGIN_ID に合わせて書き換え）
-- RDS で実行前にバックアップ推奨。

-- 方法A: subscription_status のみ（migration v8 済み）
-- UPDATE users SET subscription_status = 'active' WHERE LOWER(email) = LOWER('your-test@example.com');

-- 方法B: is_premium のみ（migration v9 済み）
-- UPDATE users SET is_premium = 1 WHERE id = 1;

-- 方法C: 両方そろえる
-- UPDATE users SET subscription_status = 'active', is_premium = 1 WHERE id = 1;
