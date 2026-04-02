# local values for this environment
vpc_id = "vpc-0e90de2edaebce52f"

private_subnet_ids = ["subnet-01bd850786b67913c", "subnet-0f3c3d18e1d54889c"]

# ALB はタスクが置かれる各 AZ にサブネットが必要。private が 1c/1d なら public も 1c を含める（無いと「AZ が LB で有効でない」で 503）
public_subnet_ids = ["subnet-0f40996eeab2d1a5f", "subnet-00ccad57c7b377706", "subnet-09ce61e45eb3451e4"]

# 本番イメージ（apply 時は直近の ECS タスク定義に合わせて更新）
container_image = "345362761619.dkr.ecr.ap-northeast-1.amazonaws.com/kakeibo-api:63d1c6e9e9ff92a557823f84afd49f782a280b59"

github_oidc_provider_arn = "arn:aws:iam::345362761619:oidc-provider/token.actions.githubusercontent.com"
github_repository        = "Ksystem1/kakeibo-app"
github_branch            = "main"

app_secret_arns = {}

# api.ksystemapp.com 用 ACM（ap-northeast-1・発行済み）
alb_certificate_arn = "arn:aws:acm:ap-northeast-1:345362761619:certificate/3a41ceda-705e-4914-8e6e-e3b97303216e"

# Route 53: api.ksystemapp.com → ALB（A エイリアス）
api_route53_lookup_domain = "ksystemapp.com"
