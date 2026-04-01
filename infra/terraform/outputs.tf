output "nameservers" {
  description = "レジストラに登録するネームサーバ（新規ホストゾーンのとき）"
  value       = var.create_hosted_zone ? aws_route53_zone.primary[0].name_servers : null
}

output "hosted_zone_id" {
  value = local.zone_id
}

output "site_bucket_name" {
  description = "npm run build 後: aws s3 sync dist/ s3://<この名前>/kakeibo/ --delete"
  value       = aws_s3_bucket.spa.bucket
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.site.domain_name
}

output "app_public_url" {
  description = "家計簿アプリの URL"
  value       = "https://${var.root_domain}/${var.app_path_prefix}/"
}

output "apex_redirect_note" {
  description = "https://<domain>/ は CloudFront Function で /kakeibo/ に 302"
  value       = "https://${var.root_domain}/ → ${local.redirect_target}"
}

output "api_custom_domain_target" {
  description = "App Runner に紐付ける API 用 FQDN（Terraform 外で設定）"
  value       = "${var.api_subdomain}.${var.root_domain}"
}

output "acm_certificate_arn_us_east_1" {
  value       = aws_acm_certificate.cloudfront.arn
  description = "CloudFront 用（us-east-1）。出力参照用。"
}
