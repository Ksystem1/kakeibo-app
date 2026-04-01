resource "aws_route53_zone" "primary" {
  count = var.create_hosted_zone ? 1 : 0
  name  = var.root_domain
}

data "aws_route53_zone" "existing_by_name" {
  count        = var.create_hosted_zone || var.existing_zone_id != "" ? 0 : 1
  name         = "${var.root_domain}."
  private_zone = false
}

locals {
  zone_id = var.create_hosted_zone ? aws_route53_zone.primary[0].zone_id : (
    var.existing_zone_id != "" ? var.existing_zone_id : data.aws_route53_zone.existing_by_name[0].zone_id
  )
  redirect_target = "/${var.app_path_prefix}/"
}
