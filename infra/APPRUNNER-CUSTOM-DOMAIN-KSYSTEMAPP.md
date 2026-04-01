# App Runner カスタムドメイン（ksystemapp.com）— 紐付けガイド

## まず重要：apex と API の役割分担

| ホスト名 | 用途 | サービス |
|----------|------|----------|
| **`ksystemapp.com`** | 家計簿 SPA（`https://ksystemapp.com/kakeibo/`） | **CloudFront + S3**（Terraform 等） |
| **`api.ksystemapp.com`** | REST API | **App Runner カスタムドメイン** |

**同じ `ksystemapp.com` を App Runner のカスタムドメインにも CloudFront の別名にも付けることはできません**（HTTPS の終端が競合します）。  
そのため **App Runner には `api.ksystemapp.com`（サブドメイン）を付けます**。

---

## 事前準備（東京リージョン）

1. コンソール右上でリージョンを **アジアパシフィック（東京）ap-northeast-1** にする。  
2. **ACM（Certificate Manager）** を開く。  
3. **証明書をリクエスト** → **パブリック証明書** → ドメイン名に **`api.ksystemapp.com`**。  
4. 検証方法 **DNS 検証** → **Route 53 でレコードを作成**（ボタンがあれば一括作成）。  
5. ステータスが **発行済み** になるまで待つ。

---

## App Runner でカスタムドメインをリンクする（コンソール）

1. **AWS コンソール** → サービス検索で **App Runner** を開く。  
2. 左または一覧から **対象のサービス**（家計簿 API）をクリック。  
3. 上部タブで **「カスタムドメイン」**（Custom domains）を開く。  
4. **「カスタムドメインをリンク」** / **Link domain** をクリック。  
5. **ドメイン** に **`api.ksystemapp.com`** を入力。  
6. **証明書** で、上で発行した **東京リージョンの ACM 証明書** を選択。  
7. ウィザードに従い進める。  
8. **検証用の DNS レコード**（CNAME など）が表示されたら:

### Route 53 でのレコード（自動または手動）

- ウィザードに **「Route 53 でレコードを作成」** があれば、それで **`ksystemapp.com` ホストゾーン** に追加。  
- 手動の場合の例（**表示値は必ずコンソールの値に置き換え**。ここは例）:

| 種別 | レコード名 | 値 |
|------|------------|-----|
| **CNAME**（検証） | `_xxxxxxxx.api.ksystemapp.com` | `_yyyy.acm-validations.aws.` など（ACM/App Runner が表示） |
| **トラフィック用** | App Runner が **別名（ALIAS）** または **CNAME** で指示したターゲット | 例: `xxxxxxxx.ap-northeast-1.awsapprunner.com` 等（**サービス画面のコピー値をそのまま**） |

**注意:** 実際の **名前・TTL・値** は **App Runner のカスタムドメイン画面に表示されるとおり**にしてください。リージョンやサービスごとに異なります。

9. ステータスが **アクティブ / 正常** になるまで待つ（数分〜）。

---

## CLI の参考（コンソールと同等）

```bash
aws apprunner associate-custom-domain \
  --region ap-northeast-1 \
  --service-arn "arn:aws:apprunner:ap-northeast-1:アカウントID:service/サービス名/ID" \
  --domain-name api.ksystemapp.com
```

表示された検証レコードを Route 53 に追加します。

---

## バックエンド環境変数（App Runner）

サービス **「設定」→「環境変数」** に例:

| 名前 | 値 |
|------|-----|
| `CORS_ORIGIN` | `https://ksystemapp.com` |

（CORS のオリジンに **パス `/kakeibo` は含めません**。）

ローカル開発も併用する場合はカンマ区切りで `http://localhost:5173` などを追加（`backend/.env.example` 参照）。

---

## フロント（ビルド）

```bash
set VITE_API_URL=https://api.ksystemapp.com
npm run build
```

---

## よくあるつまずき

| 現象 | 確認 |
|------|------|
| 証明書が作れない | リージョンが **東京** か、ドメイン名が **`api.ksystemapp.com`** と一致しているか |
| 検証が終わらない | レコードが **`ksystemapp.com` のホストゾーン** にあり、名前が **完全修飾名どおり**か |
| CORS エラー | `CORS_ORIGIN` が **`https://ksystemapp.com`** と一致（スキーム・ホスト） |
