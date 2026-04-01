# Terraform: Route 53 + ACM (us-east-1) + S3 + CloudFront（パス `/kakeibo/`）

## Terraform のインストール（未導入の場合）

- [公式インストール手順](https://developer.hashicorp.com/terraform/install)  
- Windows 例: `winget install Hashicorp.Terraform` 後、新しいターミナルを開く。

## 前提

- AWS CLI（`aws configure` 済み）と Terraform が使えること。
- **ドメインを Route 53 で新規登録する場合**、ホストゾーン作成後にレジストラへ **NS を委任**してからでないと、ACM の DNS 検証が完了しません。
- **コンソールで既にホストゾーンがある場合**（例: `ksystemapp.com`）は **ゾーンをもう一度作らない**。`terraform.tfvars` で `create_hosted_zone = false` と **`existing_zone_id = "Z..."`**（ホストゾーン詳細に表示される ID）を必ず指定する。

## 手順（概要）

```powershell
cd infra/terraform
# 初回のみ: copy terraform.tfvars.example terraform.tfvars（ksystemapp.com 用はリポジトリに同梱の terraform.tfvars を参照）

terraform init
terraform plan
terraform apply
```

- **`create_hosted_zone = false`** のとき、`existing_zone_id` を空にすると **`root_domain` 名でパブリックホストゾーンを自動検索**します（コンソールで作った `ksystemapp.com` 向け）。
- apply 後、**apex の A/AAAA** が CloudFront を向き、`https://ksystemapp.com/` が名前解決できるようになります。

apply 後、`outputs` の **nameservers** をドメイン登録先に設定 → しばらく待ってから `terraform apply` で検証が完了する場合があります（初回はゾーンだけ先に作り、NS 反映後に cert + CF 、という二段階になることもあります）。

## フロントの配置

```bash
# ルートで
set VITE_API_URL=https://api.ksystem.com
npm run build
aws s3 sync dist/ s3://<site_bucket_name>/kakeibo/ --delete
aws cloudfront create-invalidation --distribution-id <id> --paths "/kakeibo/*" "/*"
```

## App Runner のカスタムドメイン

`apprunner.yaml` にはカスタムドメインを書けません。`../ROUTE53-APPRUNNER-PATH-GUIDE.md` の手順でコンソールまたは CLI を使用してください。
