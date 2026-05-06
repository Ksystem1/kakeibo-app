# local values for this environment
vpc_id = "vpc-0e90de2edaebce52f"

private_subnet_ids = ["subnet-01bd850786b67913c", "subnet-0f3c3d18e1d54889c"]

# ALB はタスクが置かれる各 AZ にサブネットが必要。private が 1c/1d なら public も 1c を含める（無いと「AZ が LB で有効でない」で 503）
public_subnet_ids = ["subnet-0f40996eeab2d1a5f", "subnet-00ccad57c7b377706", "subnet-09ce61e45eb3451e4"]

# 本番イメージ（apply 時は直近の ECS タスク定義に合わせて更新）
container_image = "345362761619.dkr.ecr.ap-northeast-1.amazonaws.com/kakeibo-api:5f8d82d"

github_oidc_provider_arn = "arn:aws:iam::345362761619:oidc-provider/token.actions.githubusercontent.com"
github_repository        = "Ksystem1/kakeibo-app"
github_branch            = "main"

# -----------------------------------------------------------------------------
# ECS コンテナへ注入するシークレット（タスク起動時に実行ロールが取得）
# ・ARN は必ず arn:aws:secretsmanager:... または arn:aws:ssm:... で始める（プレーン文字列は不可）
# ・RDS: (A) rds-credentials.auto.tfvars.example をコピーして manage_rds_credentials_secret=true で一括登録
#        (B) 手動で Secrets/SSM を作ったら下記 app_secret_arns に RDS_* を追加
# ・RDS を SSM に置く場合は VPC エンドポイント ssm（本モジュールで作成済み）が必要
# -----------------------------------------------------------------------------
app_secret_arns = {
  JWT_SECRET = "arn:aws:secretsmanager:ap-northeast-1:345362761619:secret:kakeibo/prod/jwt_secret-uoM336"

  # --- 手動 ARN 運用時のみ（Terraform 一括管理なら不要）---
  # RDS_HOST     = "arn:aws:ssm:ap-northeast-1:345362761619:parameter/kakeibo/prod/rds_host"
  # RDS_PORT     = "arn:aws:ssm:ap-northeast-1:345362761619:parameter/kakeibo/prod/rds_port"
  # RDS_USER     = "arn:aws:secretsmanager:ap-northeast-1:345362761619:secret:kakeibo/prod/rds_user-XXXXXX"
  # RDS_PASSWORD = "arn:aws:secretsmanager:ap-northeast-1:345362761619:secret:kakeibo/prod/rds_password-XXXXXX"
  # RDS_DATABASE = "arn:aws:ssm:ap-northeast-1:345362761619:parameter/kakeibo/prod/rds_database"
}

# RDS database-1 の VPC SG（ECS プライベートサブネットから 3306 へ到達させる）
rds_security_group_id = "sg-00a70c69b9ef44e4d"
rds_port              = 3306

# api.ksystemapp.com 用 ACM（ap-northeast-1・発行済み）
alb_certificate_arn = "arn:aws:acm:ap-northeast-1:345362761619:certificate/3a41ceda-705e-4914-8e6e-e3b97303216e"

# Route 53: api.ksystemapp.com → ALB（A エイリアス）
api_route53_lookup_domain = "ksystemapp.com"

# Textract 到達が不安定なとき、フロント（25s）より先に手入力フォールバックを返すため短縮。
app_env_vars = {
  NODE_ENV                    = "production"
  API_PORT                    = "3456"
  CORS_ORIGIN                 = "https://ksystemapp.com,https://www.ksystemapp.com"
  JWT_EXPIRES_IN              = "7d"
  ALLOW_X_USER_ID             = "false"
  AUTH_DEBUG_TOKEN            = "false"
  AWS_REGION                  = "ap-northeast-2"
  AWS_DEFAULT_REGION          = "ap-northeast-2"
  TEXTRACT_ENABLED            = "true"
  TEXTRACT_TIMEOUT_MS         = "22000"
  TEXTRACT_MAX_IMAGE_BYTES    = "5242880"
  TEXTRACT_MAX_ATTEMPTS       = "2"
  TEXTRACT_SEND_RETRIES       = "2"
  TEXTRACT_CONNECT_TIMEOUT_MS = "5000"
  TEXTRACT_SOCKET_TIMEOUT_MS  = "22000"
  # WebAuthn / 招待URL（本番）— 未設定でもコード既定で ksystemapp だが、ECS 上で明示
  WEBAUTHN_ORIGIN           = "https://ksystemapp.com"
  WEBAUTHN_RP_ID            = "ksystemapp.com"
  WEBAUTHN_ADDITIONAL_ORIGINS = "https://www.ksystemapp.com"
  PUBLIC_APP_ORIGIN         = "https://ksystemapp.com"
}

# Stripe（本番）:
# 値本体は GitHub Secrets（Repository secrets）で注入する:
#   STRIPE_PRICE_ID（本番の price_... → ECS の STRIPE_PRICE_ID）, STRIPE_TEST_PRICE_ID（→ STRIPE_TEST_PRICE_ID）,
#   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
# Live 本番では sk_live_ と上記 Price ID を GitHub に揃える。
# コードは sk_live_ のとき STRIPE_PRICE_ID を優先、sk_test_ のとき STRIPE_TEST_PRICE_ID を優先。
# この tfvars に平文で置く必要はない。
