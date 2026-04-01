# Step 3: api.<domain> を ALB へ向ける A エイリアス（任意）
# api_route53_zone_id または api_route53_lookup_domain のどちらかを設定し terraform apply

data "aws_route53_zone" "api_parent" {
  count = trimspace(var.api_route53_zone_id) == "" && trimspace(var.api_route53_lookup_domain) != "" ? 1 : 0

  name         = trimsuffix(trimspace(var.api_route53_lookup_domain), ".")
  private_zone = false
}

locals {
  api_route53_zone_effective = trimspace(var.api_route53_zone_id) != "" ? trimspace(var.api_route53_zone_id) : (
    length(data.aws_route53_zone.api_parent) > 0 ? data.aws_route53_zone.api_parent[0].zone_id : ""
  )
}

data "aws_route53_zone" "api_hosted_zone" {
  count   = trimspace(local.api_route53_zone_effective) != "" ? 1 : 0
  zone_id = local.api_route53_zone_effective
}

locals {
  api_hosted_zone_domain = length(data.aws_route53_zone.api_hosted_zone) > 0 ? trimsuffix(data.aws_route53_zone.api_hosted_zone[0].name, ".") : ""
  # レコード名はゾーンからの相対名（例: api.ksystemapp.com + ゾーン ksystemapp.com → "api"）
  api_rr_label = local.api_hosted_zone_domain != "" ? trimsuffix(trimsuffix(var.api_public_fqdn, "."), ".${local.api_hosted_zone_domain}") : trimsuffix(var.api_public_fqdn, ".")
}

resource "aws_route53_record" "api_alias" {
  count   = trimspace(local.api_route53_zone_effective) != "" ? 1 : 0
  zone_id = local.api_route53_zone_effective
  name    = local.api_rr_label
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}
