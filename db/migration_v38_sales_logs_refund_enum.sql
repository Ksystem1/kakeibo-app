-- v38: sales_logs に refund 行を保存可能に（ENUM に refund を追加）
-- 実行: cd backend && npm run db:migrate-v38

SET NAMES utf8mb4;

ALTER TABLE sales_logs
  MODIFY COLUMN stripe_source_type
    ENUM('checkout_session', 'invoice', 'payment_intent', 'refund')
    NOT NULL
    DEFAULT 'checkout_session'
    COMMENT '元オブジェクトの種別';
