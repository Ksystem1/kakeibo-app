-- 収入を 0 円で登録できるようにする（アプリ・API は支出のみ正の数を要求）
-- MySQL 8.0.16+（CHECK 制約対応）想定。RDS で実行してください。
--
-- 失敗する場合は制約名を確認:
--   SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
--   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND CONSTRAINT_TYPE = 'CHECK';

-- 本番RDSにこの変更（CHECK制約の入れ替え）を安全に適用する手順例:

-- 1. まず、現在すべての `transactions` レコードが `amount >= 0` を満たしているか確認します。
SELECT * FROM transactions WHERE amount < 0;
-- → 結果が0件であればOK。ヒットした場合はデータ修正が必要です。

-- 2. 制約名が本当に 'chk_transactions_amount_positive' か事前確認します。
SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND CONSTRAINT_TYPE = 'CHECK';
-- → 制約名が異なる場合は、下記 ALTER 文の名前を現物に合わせて書き換えます。

-- 3. 必ず事前にバックアップ(RDSのスナップショット等)を取ります。

-- 4. できればメンテナンス時間帯などでアプリアクセスを止めて適用します。

-- 5. 次の DROP が失敗する場合（MariaDB やエンジン差）:
--    「Unknown CHECK constraint」→ 手順2で実際の CONSTRAINT_NAME を確認し、下の B を試す。
--    「syntax error」→ MySQL 8.0.19 未満の可能性。RDS のメジャーバージョンを上げるか、
--    サポートに CHECK の扱いを確認。

-- A) MySQL 8.0.19+（Amazon RDS for MySQL 8 一般的）
ALTER TABLE transactions
  DROP CHECK chk_transactions_amount_positive;

-- B) DROP CHECK が使えない場合の例（制約名は手順2の結果に合わせる）
-- ALTER TABLE transactions DROP CONSTRAINT chk_transactions_amount_positive;

ALTER TABLE transactions
  ADD CONSTRAINT chk_transactions_amount_nonneg CHECK (amount >= 0);

-- 再実行時に「Duplicate constraint」なら、先に次を実行してから ADD し直す:
-- ALTER TABLE transactions DROP CHECK chk_transactions_amount_nonneg;

-- 以上で完了です。

-- ▼ポイント
-- ・アプリ/API側が新制約下で問題なく動作するか（0円収入が本当に許可されているか）を事前検証
-- ・不要なトランザクションロックや想定外のエラーを避けるため、DDL実行は最小限に・慎重に