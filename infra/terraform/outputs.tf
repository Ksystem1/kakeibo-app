output "nameservers" {
  description = "レジストラに登録するネームサーバ（新規ホストゾーンのとき）"
  value       = var.enable_legacy_spa_stack && var.create_hosted_zone ? aws_route53_zone.primary[0].name_servers : null
}

output "hosted_zone_id" {
  value = local.zone_id
}

output "site_bucket_name" {
  description = "npm run build 後: aws s3 sync dist/ s3://<この名前>/kakeibo/ --delete"
  value       = var.enable_legacy_spa_stack ? aws_s3_bucket.spa[0].bucket : null
}

output "cloudfront_distribution_id" {
  value = var.enable_legacy_spa_stack ? aws_cloudfront_distribution.site[0].id : null
}

output "cloudfront_domain_name" {
  value = var.enable_legacy_spa_stack ? aws_cloudfront_distribution.site[0].domain_name : null
}

output "app_public_url" {
  description = "家計簿アプリの URL"
  value       = "https://${var.root_domain}/${var.app_path_prefix}/"
}

output "apex_redirect_note" {
  description = "https://<domain>/ は CloudFront Function で /kakeibo/ に 302"
  value       = "https://${var.root_domain}/ → ${local.redirect_target}"
}

output "acm_certificate_arn_us_east_1" {
  value       = var.enable_legacy_spa_stack ? aws_acm_certificate.cloudfront[0].arn : null
  description = "CloudFront 用（us-east-1）。出力参照用。"
}
