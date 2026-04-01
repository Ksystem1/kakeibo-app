# Ksystem ドメインで外部公開する手順

**URL を `https://ksystem.com/kakeibo/` のようなパス形式にする場合**は、**[ROUTE53-APPRUNNER-PATH-GUIDE.md](./ROUTE53-APPRUNNER-PATH-GUIDE.md)** と **`infra/terraform/`** を主に参照してください（本ファイルはサブドメイン例の説明が混在します）。

家計簿アプリを **独自ドメイン** でインターネットに公開するための流れです。  
API は既存の **AWS App Runner**、画面は **S3 + CloudFront** を想定しています。

## 1. AWS でドメインを取得する（ブランド名 Ksystem・サブドメイン kakeibo）

### 名前の決め方（重要）

- ドメイン登録できるのは **「Ksystem」＋トップレベルドメイン（TLD）」** の形です。`Ksystem` だけでは登録できません。
- 例: `ksystem.com` / `ksystem.jp` / `ksystem.net` / `k-system.jp` など。**空き状況**は検索で確認します。
- **サブドメイン `kakeibo` は別料金で「取得」するものではありません。** ルートドメインを取ったあと、DNS で `kakeibo.ksystem.com` のような **レコードを追加**するだけです。
- 家計簿サイトの URL の例: **`https://kakeibo.ksystem.com`**（ルートが `ksystem.com` の場合）

### Route 53 での取得手順（コンソール）

1. AWS にログイン（リージョンは任意。ドメイン登録はグローバル）。
2. **Route 53** → **登録済みドメイン**（Registered domains）→ **ドメインを登録**（Register domain）。
3. 検索に希望名を入力（例: `ksystem` と入力し `.com` / `.jp` などから選択）。
4. カートに入れ、連絡先・支払いに従い登録を完了する。
5. 完了後、Route 53 に **ホストゾーン**（例: `ksystem.com`）ができるので、ACM の DNS 検証や CloudFormation の `HostedZoneId` に使えます。

### `.jp` について

- Route 53 で取れる TLD は変わることがあります。検索に出なければ [Route 53 が提供するドメイン一覧](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/registrar-tld-list.html)を確認するか、国内レジストラで取得してネームサーバを Route 53 に向ける方法もあります。

### サブドメイン `kakeibo` の向き先

- **画面**: `kakeibo.<ルートドメイン>` を CloudFront に向ける（CloudFormation の `SiteDomainName` にその FQDN を指定）。
- **API（推奨）**: `api.<ルートドメイン>` を App Runner のカスタムドメインに向ける。

## 2. ドメインと DNS（既に他社で取得済みの場合）

- **Route 53 にホストゾーン**を作るか、外部 DNS で CNAME/ALIAS を設定します。
- 推奨の名前の例:
  - 画面: `kakeibo.ksystem.example`（`example` を実ドメインに置き換え）
  - API: `api.ksystem.example`（App Runner のカスタムドメインに紐づける）

## 2.5 次のステップ（ルートドメイン確定後 — FQDN を ACM / CloudFormation でそろえる）

ドメイン取得が完了し、Route 53 に **ホストゾーン**（例: `ksystem.com`）がある状態から、ここを順に進めます。

**原則:** 画面用 FQDN（例: `kakeibo.ksystem.com`）を、**(A) ACM のドメイン名（または SAN）** と **(B) CloudFormation の `SiteDomainName`** の **両方で同じ文字列**にしてください。ずれると HTTPS エラーやデプロイ失敗になります。

| 項目 | 例 | どこで使うか |
|------|-----|----------------|
| 画面 FQDN | `kakeibo.ksystem.com` | ブラウザの URL / `SiteDomainName` |
| ホストゾーン ID | `Z0abc…` | CloudFormation の `HostedZoneId` |
| ACM（us-east-1） | 上記 FQDN 用、または `*.ksystem.com` | `AcmCertificateArn`（CloudFront） |
| API FQDN | `api.ksystem.com` | App Runner カスタムドメイン / `VITE_API_URL` |

### A. HostedZoneId を取得する

AWS CLI の例（ルートが `ksystem.com` のとき）:

```bash
aws route53 list-hosted-zones-by-name --dns-name ksystem.com.
```

`HostedZones[0].Id` が `/hostedzone/Z1234567890ABC` の形式なら、**`Z1234567890ABC` だけ**を `HostedZoneId` に使います。

### B. ACM で証明書（CloudFront 用・us-east-1）

1. コンソールのリージョンを **バージニア北部（us-east-1）** に切り替え。
2. **ACM** → 証明書をリクエスト → **DNS 検証**。
3. ドメイン名に **`kakeibo.ksystem.com`**（実際のルートに合わせる）を入れる。複数サブドメインをまとめたい場合は **`*.ksystem.com`** など（ルート `ksystem.com` も載せたい場合は SAN 追加）。
4. Route 53 に表示どおり **CNAME を作成**（ボタン一発で追加できる画面が出ます）→ ステータスが **発行済み** になるまで待つ。
5. 証明書の **ARN** をコピー（CloudFormation の `AcmCertificateArn` にそのまま貼る）。

API 用 `api.ksystem.com` は **別証明書**が必要です。**東京（ap-northeast-1）** の ACM で同様に DNS 検証し、**App Runner** の「カスタムドメイン」設定で使います（[App Runner カスタムドメイン](https://docs.aws.amazon.com/apprunner/latest/dg/manage-custom-domains.html)）。

### C. CloudFormation を実行する

`SiteDomainName` に **A と同じ画面 FQDN**、`AcmCertificateArn` に **B の us-east-1 の ARN**、`HostedZoneId` に **A の ID** を入れます（セクション 4 のコマンドと同じ）。

完了後、しばらくして **`https://kakeibo.ksystem.com`**（実際の FQDN）で画面が開くか確認します。まだバケットが空なら 403/真っ白でもよいので、次の **セクション 5** で `npm run build` した `dist/` を S3 に sync します。

### D. フロントの API 先と CORS

- ビルド時: `VITE_API_URL=https://api.ksystem.com`（実際の API FQDN）。
- App Runner の環境変数: `CORS_ORIGIN=https://kakeibo.ksystem.com`（**画面のオリジン**と一致）。

### 値のメモ用ひな型

`infra/env.deploy.example` をコピーし、ローカル専用ファイルに値を書いて管理してください（**Git にコミットしない**こと）。

## 3. SSL 証明書（ACM）

CloudFront 用は **リージョンを us-east-1（バージニア北部）** にした ACM で証明書を発行します。

1. ACM（us-east-1）→ 証明書をリクエスト → ドメイン名に `kakeibo.ksystem.example` または `*.ksystem.example`。
2. DNS 検証用の CNAME を Route 53 等に追加し、**ステータスが「発行済み」**になるまで待つ。
3. 証明書 ARN をメモする（例: `arn:aws:acm:us-east-1:123456789012:certificate/...`）。

App Runner 用の API サブドメインは **東京（ap-northeast-1）の ACM** で別証明書を発行し、App Runner コンソールの「カスタムドメイン」から紐づけます（公式手順に従ってください）。

## 4. フロント用スタックのデプロイ

プロジェクトルートで（`SiteDomainName` と `AcmCertificateArn` を自分の値に）:

```bash
aws cloudformation deploy \
  --stack-name kakeibo-web-ksystem \
  --template-file infra/cloudformation/spa-s3-cloudfront.yaml \
  --parameter-overrides \
    SiteDomainName=kakeibo.ksystem.example \
    AcmCertificateArn=arn:aws:acm:us-east-1:ACCOUNT_ID:certificate/UUID \
    HostedZoneId=Zxxxxxxxx \
  --capabilities CAPABILITY_IAM \
  --region ap-northeast-1
```

- `HostedZoneId` を空にすると Route 53 レコードは作られません。外部 DNS の場合は、出力の CloudFront ドメインへ **CNAME または ALIAS** を手動で設定します。
- 出力の `BucketName` と `DistributionId` をメモし、GitHub Actions のシークレットに使います。

## 5. フロントのビルドとアップロード

API の URL を **HTTPS の API ドメイン**に合わせてからビルドします（`VITE_*` はビルド時に埋め込まれます）。

```bash
set VITE_API_URL=https://api.ksystem.example
npm ci
npm run deploy:prod
```

`deploy:prod` は次を一括実行します。

- `npm run build`
- `aws s3 sync dist/ s3://$S3_BUCKET/kakeibo/ --delete`
- `aws cloudfront create-invalidation --distribution-id $CLOUDFRONT_DISTRIBUTION_ID --paths "/*"`

事前に環境変数を設定してください（未設定時は既定値あり）。

```bash
set S3_BUCKET=ksystemapp-web-production
set CLOUDFRONT_DISTRIBUTION_ID=E1234567890ABC
set AWS_REGION=ap-northeast-1
```

## 6. バックエンドの CORS

App Runner（または API サーバー）の環境変数 `CORS_ORIGIN` に、**画面のオリジン**を列挙します。

例:

```text
CORS_ORIGIN=https://kakeibo.ksystem.example
```

複数ある場合はカンマ区切り。ワイルドカードはこのアプリの実装では使わず、明示的に URL を列挙する運用を推奨します。

## 7. 本番で必ず設定すること

- `JWT_SECRET`: 十分に長いランダム文字列。
- `ALLOW_X_USER_ID`: 本番では `false` または未設定。
- RDS 接続情報とマイグレーション（`db/migration_v2_auth_families.sql` 等）の適用。

## 8. GitHub から自動デプロイ

リポジトリの **Settings → Secrets and variables → Actions** に次を設定し、`main` への push で `.github/workflows/deploy-frontend.yml` が動くようにします。

- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`（または OIDC 用ロールはワークフロー改修が必要）
- `S3_BUCKET`（スタック出力の BucketName）
- `CLOUDFRONT_DISTRIBUTION_ID`（スタック出力の DistributionId）
- `VITE_API_URL`（例: `https://api.ksystem.example`）

IAM ユーザー/ロールには少なくとも対象バケットへの `s3:PutObject` 等と、該当ディストリビューションへの `cloudfront:CreateInvalidation` を付与します。
