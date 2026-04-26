# 本番 RDS へ v42 を手動適用する手順

`migration_v42_user_store_places_bedrock.sql` は **テーブル／列コメントの更新**（`user_store_places` の役割を Amazon Bedrock 名寄せ向けに明文化）です。スキーマの必須カラム追加は含みません。

## 前提

- **GitHub Actions や ECS からは実行しません**（workflow コメントどおり、DDL は手元または踏み台から実施する運用です）。
- 接続先は **本番 RDS**（`backend/.env` の `RDS_HOST` 等と一致する値を使う）。
- 可能なら **バックアップ取得**（RDS スナップショット等）のうえで実施してください。

## 手順

1. **リポジトリを最新にする**（v42 の SQL と `run-migration-v42.mjs` が含まれるコミットを取得）。
2. **ローカル（または VPC 内の踏み台）**で `backend/.env` に本番 RDS 接続情報を設定  
   - `RDS_HOST`, `RDS_PORT`, `RDS_USER`, `RDS_PASSWORD`, `RDS_DATABASE`  
   - TLS 要件に応じて既存の `RDS_SSL` 方針に合わせる。
3. リポジトリ**ルート**で実行:
   ```bash
   npm run db:migrate-v42
   ```
   実体は `cd backend && node scripts/run-migration-v42.mjs` です。
4. 成功時、ターミナルに `migration_v42_user_store_places_bedrock.sql の適用が完了しました。` が出ます。
5. **本番 API** でレシート名寄せ（Bedrock）が想定どおり動くか、負荷の少ない時間帯に **スモークテスト**（プレミアムで `POST /receipts/resolve-suggested-vendor` 等）を推奨します。

## 補足（image_553a41.png / スキーマ確認）

v42 適用前後で `user_store_places` の**列集合は v40/v41 と同じ**です。ER 図（image_553a41.png 等）で列名を照合する場合は `place_id` / `display_name` / `formatted_address` / `preferred_category_id` を参照してください。v42 では主に **COMMENT** が更新されます。
