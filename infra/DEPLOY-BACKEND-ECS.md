# Backend Deploy (ECS + ALB)

本番 backend は `ECS + ALB` で運用します。`App Runner` は補助用途です。

## 推奨（Docker 不要）

GitHub Actions の `deploy.yml` を実行してください。

1. GitHub -> Actions
2. `Deploy backend (ECS Fargate + Terraform)` を選択
3. `Run workflow` を実行

この workflow は以下を自動実行します。

- ECR login
- backend の Docker build/push
- `infra/terraform-ecs-express` で `terraform init/plan/apply`

## ローカル実行（Docker 必要）

1. `backend/` を Docker build して ECR push
2. `infra/terraform-ecs-express/terraform.tfvars` の `container_image` を更新
3. `terraform init && terraform apply`

## 注意

- `npm run deploy:backend` は ECS 運用の案内を表示します。
- App Runner を更新したい場合のみ `npm run deploy:backend:apprunner` を使用してください。

## 開発時の前提（必読）

- **本番への backend 反映は GitHub Actions（`deploy.yml`）を前提とする。** 手元だけで完結させず、マージ後に Actions が通る想定でコード・設定を書く。
- **`infra/terraform-ecs-express/terraform.tfvars` や Terraform モジュールを変えたら、差分が意図どおりか毎回確認する**（`container_image` の手動更新と Actions 経由のイメージタグのズレ、`app_env_vars` / `app_secret_arns` の追加忘れなど）。

### 修正後のダブルチェック例

1. 新しい環境変数を `backend` が読む場合 → `terraform.tfvars` の `app_env_vars` または Secrets の ARN を更新したか。
2. `backend/package.json` や `Dockerfile` を変えた場合 → `deploy.yml` の `docker build` がそのまま通るか。
3. ルートや認可を変えた場合 → フロントの `VITE_API_URL` と CORS（`CORS_ORIGIN`）に矛盾がないか。
