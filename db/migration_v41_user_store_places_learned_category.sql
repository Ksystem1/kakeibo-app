-- 店名名寄せと学習済み支出カテゴリの紐付け
-- 実行: cd backend && npm run db:migrate-v41
SET NAMES utf8mb4;

ALTER TABLE user_store_places
  ADD COLUMN preferred_category_id BIGINT UNSIGNED NULL
    COMMENT 'ユーザーが学習した支出一覧カテゴリ（同じOCR店名次回最優先）' AFTER formatted_address,
  ADD KEY idx_user_store_places_pref_cat (user_id, ocr_vendor_key, preferred_category_id);

ALTER TABLE user_store_places
  ADD CONSTRAINT fk_user_store_places_preferred_category
    FOREIGN KEY (preferred_category_id) REFERENCES categories (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE;
