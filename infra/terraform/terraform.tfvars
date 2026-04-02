# API（ECS+Fargate+ALB+HTTPS+api.ksystemapp.com DNS）は infra/terraform-ecs-express/terraform.tfvars で管理。
# ローカル用（.gitignore 対象）。ksystemapp.com の既存ホストゾーンに CloudFront / S3 / ACM を作成
root_domain        = "ksystemapp.com"
app_path_prefix    = "kakeibo"
api_subdomain      = "api"
aws_region         = "ap-northeast-1"
create_hosted_zone = false
existing_zone_id   = ""
include_www_alias  = false

# フロント配信（CloudFront オリジンと GitHub Actions の S3_BUCKET）
manage_frontend_artifacts_bucket = true
frontend_artifacts_bucket_name   = "ksystemapp-web-production"
