variable "aws_region" {
  description = "Deployment region"
  type        = string
  default     = "ap-northeast-1"
}

variable "name_prefix" {
  description = "Prefix used for created resources"
  type        = string
  default     = "kakeibo-api"
}

variable "vpc_id" {
  description = "VPC ID where ECS/ALB are deployed"
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs for ALB. Must include at least one subnet per AZ where private_subnet_ids place tasks; otherwise targets fail with «AZ not enabled for the load balancer» and /health returns 503."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS tasks (Fargate). Each AZ used here must be covered by public_subnet_ids on the ALB."
  type        = list(string)
}

variable "allowed_cidr_blocks" {
  description = "Public CIDRs allowed to access ALB"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "alb_certificate_arn" {
  description = <<-EOT
    ap-northeast-1 の ACM 証明書 ARN（HTTPS リスナー用）。
    非空のとき: ALB に 443 を追加し、80 は 301 で https にリダイレクト（同一ホスト・パス・クエリを維持）。
    空のとき: 80 のみで TG にフォワード（移行・検証用）。
    フロントが HTTPS のときは VITE_API_URL も https://（例: https://api.ksystemapp.com）必須。
  EOT
  type        = string
  default     = ""
}

variable "container_image" {
  description = "Container image URI (ECR recommended)"
  type        = string
}

variable "ecr_repository_name" {
  description = "ECR repository name used by GitHub Actions"
  type        = string
  default     = "kakeibo-api"
}

variable "container_port" {
  description = "Container listening port"
  type        = number
  default     = 3456
}

variable "task_cpu" {
  description = "Task CPU units. 512 = 0.5 vCPU"
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Task memory (MiB). 1024 = 1GB"
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Desired ECS service task count"
  type        = number
  default     = 1
}

variable "health_check_path" {
  description = "ALB target group health check path"
  type        = string
  default     = "/health"
}

variable "app_env_vars" {
  description = "Plain environment variables for containerDefinitions"
  type        = map(string)
  default = {
    NODE_ENV               = "production"
    API_PORT               = "3456"
    CORS_ORIGIN            = "https://ksystemapp.com,https://www.ksystemapp.com"
    JWT_EXPIRES_IN         = "7d"
    ALLOW_X_USER_ID        = "false"
    AUTH_DEBUG_TOKEN       = "false"
    TEXTRACT_ENABLED       = "true"
    TEXTRACT_TIMEOUT_MS    = "25000"
    TEXTRACT_MAX_IMAGE_BYTES = "5242880"
    TEXTRACT_MAX_ATTEMPTS  = "2"
    TEXTRACT_SEND_RETRIES  = "2"
  }
}

variable "app_secret_arns" {
  description = "Map of env var name -> Secrets Manager/SSM ARN"
  type        = map(string)
  default = {
    RDS_HOST     = "arn:aws:ssm:ap-northeast-1:123456789012:parameter/kakeibo/prod/rds_host"
    RDS_PORT     = "arn:aws:ssm:ap-northeast-1:123456789012:parameter/kakeibo/prod/rds_port"
    RDS_USER     = "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:kakeibo/prod/rds_user"
    RDS_PASSWORD = "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:kakeibo/prod/rds_password"
    RDS_DATABASE = "arn:aws:ssm:ap-northeast-1:123456789012:parameter/kakeibo/prod/rds_database"
    JWT_SECRET   = "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:kakeibo/prod/jwt_secret"
  }
}

variable "create_github_oidc_provider" {
  description = "Create GitHub Actions OIDC provider in this account"
  type        = bool
  default     = false
}

variable "github_oidc_provider_arn" {
  description = "Existing GitHub OIDC provider ARN (used when create_github_oidc_provider=false)"
  type        = string
  default     = ""
}

variable "github_repository" {
  description = "GitHub repository in OWNER/REPO format"
  type        = string
  default     = "OWNER/REPO"
}

variable "github_branch" {
  description = "Branch allowed to assume the GitHub Actions deploy role"
  type        = string
  default     = "main"
}

variable "api_route53_zone_id" {
  description = <<-EOT
    api 用レコードを置くパブリックホストゾーン ID（Z で始まる）。空なら api_route53_lookup_domain で名前検索。
    Step 3: Route 53 で api.ksystemapp.com を ALB に向ける A エイリアスを Terraform で作るときに指定。
  EOT
  type        = string
  default     = ""
}

variable "api_route53_lookup_domain" {
  description = <<-EOT
    api_route53_zone_id が空のとき、ここで親ゾーン名を指定すると data ソースで zone_id を解決する。例: ksystemapp.com（末尾の . は不要）
  EOT
  type        = string
  default     = ""
}

variable "api_public_fqdn" {
  description = "API の公開 FQDN（A エイリアスレコード名）。GitHub Secret VITE_API_URL は https://<この値>（スラッシュなし）"
  type        = string
  default     = "api.ksystemapp.com"
}
