output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "ecs_service_name" {
  value = aws_ecs_service.this.name
}

output "task_definition_arn" {
  value = aws_ecs_task_definition.this.arn
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_https_listener_enabled" {
  value       = trimspace(var.alb_certificate_arn) != ""
  description = "true のとき 443 で HTTPS 転送（ターゲットはコンテナ HTTP と同じ TG）"
}

output "vite_api_url_mixed_content_note" {
  value       = "CloudFront 等で HTTPS のフロントから呼ぶ API の VITE_API_URL は https:// 必須。http://<alb>.elb.amazonaws.com はブラウザでブロックされます。ACM（東京）で api.<ドメイン> を発行し alb_certificate_arn に指定後、Route53 でその名前を ALB にエイリアスし、Secret を https://api.<ドメイン> に更新してください。"
  description = "フロント/ALB 間のプロトコル整合の注意"
}

output "github_secret_vite_api_url" {
  value       = "https://${trimsuffix(var.api_public_fqdn, ".")}"
  description = "Step 3: GitHub → Settings → Secrets and variables → Actions → VITE_API_URL にこの値（末尾スラッシュなし）"
}

output "api_route53_alias_managed" {
  value       = length(aws_route53_record.api_alias) > 0
  description = "true のとき Terraform が api の A エイリアスを管理している"
}

output "github_actions_deploy_role_arn" {
  value = aws_iam_role.github_actions_deploy.arn
}

output "ecr_repository_url" {
  value = aws_ecr_repository.api.repository_url
}
