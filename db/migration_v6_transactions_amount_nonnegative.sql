-- 収入を 0 円で登録できるようにする（アプリ・API は支出のみ正の数を要求）
-- MySQL 8.0.16+（CHECK 制約対応）想定。RDS で実行してください。
--
-- 失敗する場合は制約名を確認:
--   SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
--   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND CONSTRAINT_TYPE = 'CHECK';

ALTER TABLE transactions
  DROP CHECK chk_transactions_amount_positive;

ALTER TABLE transactions
  ADD CONSTRAINT chk_transactions_amount_nonneg CHECK (amount >= 0);
