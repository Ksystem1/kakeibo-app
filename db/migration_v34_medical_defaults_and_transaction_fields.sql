ALTER TABLE categories
  ADD COLUMN is_medical_default TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'カテゴリ選択時に医療費控除明細として初期化するか' AFTER is_archived,
  ADD COLUMN default_medical_type ENUM('treatment','medicine','other') NULL COMMENT 'カテゴリ既定の医療費区分（3区分）' AFTER is_medical_default,
  ADD COLUMN default_patient_name VARCHAR(120) NULL COMMENT 'カテゴリ既定の対象者名' AFTER default_medical_type;

ALTER TABLE transactions
  ADD COLUMN is_medical_expense TINYINT(1) NOT NULL DEFAULT 0 COMMENT '医療費控除対象か' AFTER memo,
  ADD COLUMN medical_type ENUM('treatment','medicine','other') NULL COMMENT '医療費控除の3区分' AFTER is_medical_expense,
  ADD COLUMN medical_patient_name VARCHAR(120) NULL COMMENT '医療費対象者名' AFTER medical_type;
