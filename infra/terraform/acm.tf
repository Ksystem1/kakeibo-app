resource "aws_acm_certificate" "cloudfront" {
  count                     = var.enable_legacy_spa_stack ? 1 : 0
  provider                  = aws.us_east_1
  domain_name               = var.root_domain
  subject_alternative_names = var.include_www_alias ? ["www.${var.root_domain}"] : []
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "acm_validation" {
  for_each = var.enable_legacy_spa_stack ? {
    for dvo in aws_acm_certificate.cloudfront[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  } : {}

  allow_overwrite = true
  zone_id         = local.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
}

resource "aws_acm_certificate_validation" "cloudfront" {
  count           = var.enable_legacy_spa_stack ? 1 : 0
  provider        = aws.us_east_1
  certificate_arn = aws_acm_certificate.cloudfront[0].arn
  validation_record_fqdns = [
    for r in aws_route53_record.acm_validation : r.fqdn
  ]
}
