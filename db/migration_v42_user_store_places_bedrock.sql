-- v42: user_store_places の役割を「Bedrock 名寄せキャッシュ」に合わせて文面のみ整理（v40 作成済みテーブル用）
-- 実行: cd backend && npm run db:migrate-v42
SET NAMES utf8mb4;

ALTER TABLE user_store_places
  COMMENT = 'ユーザー別: OCR 店名キー → 推定店名・粗い地域ヒント（Amazon Bedrock）及び学習カテゴリ。外部マップ API は使わない。';

ALTER TABLE user_store_places
  MODIFY COLUMN place_id VARCHAR(256) NULL
    COMMENT '従来 Google place id; 以降は未使用可（NULL）',
  MODIFY COLUMN display_name VARCHAR(500) NULL
    COMMENT '推定・正規化した店名表示',
  MODIFY COLUMN formatted_address VARCHAR(1000) NULL
    COMMENT '都道府県・市区町村など粗い位置ヒント（推定; 住所未入力）';
