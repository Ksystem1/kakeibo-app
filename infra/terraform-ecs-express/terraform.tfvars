# local values for this environment
vpc_id = "vpc-0e90de2edaebce52f"

private_subnet_ids = ["subnet-01bd850786b67913c", "subnet-0f3c3d18e1d54889c"]

public_subnet_ids = ["subnet-0f40996eeab2d1a5f", "subnet-09ce61e45eb3451e4"]

# ローカル plan 用プレースホルダ。本番は GitHub Actions が -var=container_image=<ECR>:<sha> で上書き。
# apply する前に ECR の実イメージ URI に合わせるか、apply 時に -var='container_image=...' を付与してください。
container_image = "nginx:latest"

github_oidc_provider_arn = "arn:aws:iam::345362761619:oidc-provider/token.actions.githubusercontent.com"
github_repository        = "Ksystem1/kakeibo-app"
github_branch            = "main"

app_secret_arns = {}

# api.ksystemapp.com 用 ACM（ap-northeast-1）が「発行済み」になったら ARN を貼り付け
# 例: alb_certificate_arn = "arn:aws:acm:ap-northeast-1:345362761619:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
alb_certificate_arn = ""

# --- Step 3: Route 53（どちらか一方を設定すると apply で A エイリアス作成）---
# 親ゾーン名で自動解決（例: ksystemapp.com）
# api_route53_lookup_domain = "ksystemapp.com"
# またはホストゾーン ID を直接
# api_route53_zone_id = "Zxxxxxxxxxxxxxxxxxxxx"
# 別サブドメインにする場合のみ変更
# api_public_fqdn = "api.ksystemapp.com"
