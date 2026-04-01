# Route 53・ACM・CloudFront（`/kakeibo/`）・App Runner カスタムドメイン — 手順ガイド

登録ドメイン **`ksystemapp.com`** で、画面 **`https://ksystemapp.com/kakeibo/`** を公開するための流れです。  
API は **`https://api.ksystemapp.com`**（App Runner カスタムドメイン）。詳細は **[APPRUNNER-CUSTOM-DOMAIN-KSYSTEMAPP.md](./APPRUNNER-CUSTOM-DOMAIN-KSYSTEMAPP.md)** を参照してください。

---

## 0. 用語

| 用語 | 意味 |
|------|------|
| ルートドメイン | `ksystemapp.com`（登録して NS を管理する名前） |
| パス URL | `https://ksystemapp.com/kakeibo/`（このリポジトリの Vite `base` と一致） |
| オリジン | CloudFront の裏の S3。オブジェクトは `kakeibo/index.html` など |

---

## 1. ドメインの選定と取得（手動・コンソール）

### 1-1. 空き確認と購入

1. AWS コンソール → **Route 53** → **ドメインの登録**（またはお好みのレジストラ）。
2. 希望名（例: `ksystem.com`）を検索。**取得済み**の場合は **`ksystemapp.com`** など別名で登録。
4. 連絡先・自動更新・プライバシー設定を入力し、**決済**まで完了。

### 1-2. ホストゾーン

- **Route 53 でドメインを買った場合**、多くの場合 **ホストゾーンが自動作成**されます。左メニュー **ホストゾーン** で **`ksystemapp.com`** があるか確認。
- **別レジストラで取得した場合**は、次のいずれか:
  - **A**: このリポジトリの **Terraform**（`infra/terraform`）で `aws_route53_zone` を作成し、出力の **ネームサーバ 4 件**をレジストラに登録。
  - **B**: CloudFormation `infra/cloudformation/route53-hosted-zone.yaml` をデプロイし、出力 **NameServers** をレジストラに登録。

**重要:** ネームサーバの切り替えが終わるまで（数分〜48時間）、DNS 検証やサイト表示は不安定になり得ます。

---

## 2. IaC でインフラを作る（Terraform 推奨）

### 2-1. 準備

1. [Terraform](https://developer.hashicorp.com/terraform/install) をインストール。
2. AWS 認証情報（`aws configure` など）を設定。
3. `infra/terraform/terraform.tfvars.example` を `terraform.tfvars` にコピー。
4. **`root_domain`** を `ksystemapp.com` に設定（既存ゾーンなら `create_hosted_zone = false` と `existing_zone_id`）。

### 2-2. apply

```bash
cd infra/terraform
terraform init
terraform apply
```

- **初回**で NS がまだレジストラに未設定だと、ACM の検証が **Pending** のままになることがあります。NS 反映後、もう一度 `terraform apply` してください。
- 出力 **`site_bucket_name`** / **`cloudfront_distribution_id`** をメモ。

### 2-3. フロントをアップロード

```bash
# プロジェクトルート
set VITE_API_URL=https://api.ksystemapp.com
set S3_BUCKET=<site_bucket_name>
set CLOUDFRONT_DISTRIBUTION_ID=<id>
npm run deploy:prod
```

`api.ksystemapp.com` は App Runner カスタムドメインで有効化後に使います。

### 2-4. 確認用 URL

- **`https://ksystemapp.com/`** → CloudFront Function で **`/kakeibo/`** に 302。
- **`https://ksystemapp.com/kakeibo/`** → 家計簿 SPA。

---

## 3. 証明書（ACM）の要点

| 用途 | リージョン | ドメイン例 |
|------|------------|------------|
| **CloudFront（画面）** | **us-east-1（バージニア北部）必須** | `ksystemapp.com`（＋任意で `www`） |
| **App Runner（API）** | **ap-northeast-1（東京）** | `api.ksystemapp.com` |

- CloudFront 用は Terraform 内で **us-east-1 の ACM** を作成し、Route 53 で **DNS 検証**します。
- App Runner 用は **東京の ACM** で **`api.ksystemapp.com`** を別途発行し、コンソールのウィザードに従って **検証レコード**を Route 53 に追加します。

---

## 4. App Runner のカスタムドメイン（手動または CLI）

**`apprunner.yaml` にはカスタムドメインを記述する項目がありません**（ビルド／ランタイム定義のみ）。紐付けは **コンソール** または **API/CLI** です。

### 4-1. コンソール

1. **App Runner** → 対象サービス → **カスタムドメイン** → **リンクの作成**。
2. ドメインに **`api.ksystemapp.com`** を入力。
3. 表示される **ACM 検証用レコード**（および必要なら **別リージョンの証明書**手順）に従い、Route 53 に CNAME 等を追加。
4. ステータスが **アクティブ**になるまで待つ。

### 4-2. CLI の例

```bash
aws apprunner associate-custom-domain ^
  --service-arn "arn:aws:apprunner:ap-northeast-1:アカウントID:service/サービス名/ID" ^
  --domain-name api.ksystemapp.com ^
  --region ap-northeast-1
```

（PowerShell では行継続に `^`、bash では `\`。）

表示された **CertificateValidationRecords** を Route 53 に追加します。

### 4-3. バックエンドの CORS

App Runner の環境変数:

```text
CORS_ORIGIN=https://ksystemapp.com
```

（CORS のオリジンに **パスは含めません**。`https://ksystemapp.com` で足ります。）

フロントのビルド:

```text
VITE_API_URL=https://api.ksystemapp.com
```

---

## 5. `apprunner.yaml` に書いてあること（参考）

リポジトリの `backend/apprunner.yaml` には **カスタムドメインは書けない**ため、先頭コメントで **API 用 FQDN とコンソール手順**を参照する形にしています。ランタイム（Node 20・ポート 8080）は従来どおりです。

---

## 6. CloudFormation だけ使う場合

- **ホストゾーンのみ:** `infra/cloudformation/route53-hosted-zone.yaml`
- **パス付き SPA 全体（S3+CloudFront+ACM+別途手動 NS）** はテンプレートが長大になるため、**Terraform（`infra/terraform`）を推奨**します。

---

## 7. トラブルシュート

| 現象 | 確認 |
|------|------|
| ACM が Issued にならない | レジストラの NS が Route 53 の NS と一致しているか |
| 画面が真っ白 | `s3://bucket/kakeibo/` に `index.html` と `assets/` があるか、`VITE_API_URL` 付きでビルドしたか |
| API が CORS エラー | `CORS_ORIGIN` が `https://ksystemapp.com` と一致しているか（スキーム・ホスト） |

---

## 8. 関連ファイル

| ファイル | 内容 |
|----------|------|
| `infra/terraform/*` | ホストゾーン・ACM(us-east-1)・S3・CloudFront・エイリアス A/AAAA |
| `infra/cloudformation/route53-hosted-zone.yaml` | ホストゾーンのみ |
| `backend/apprunner.yaml` | App Runner ビルド定義＋カスタムドメイン注記 |
| `vite.config.ts` | `base: '/kakeibo/'` |
| `.github/workflows/deploy-frontend.yml` | `s3 sync .../kakeibo/` |
