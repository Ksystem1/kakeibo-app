# ローカル用（.gitignore 対象）。ksystemapp.com の既存ホストゾーンに CloudFront / S3 / ACM を作成
root_domain        = "ksystemapp.com"
app_path_prefix    = "kakeibo"
api_subdomain      = "api"
aws_region         = "ap-northeast-1"
create_hosted_zone = false
existing_zone_id   = ""
include_www_alias  = false
