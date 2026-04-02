# プライベートサブネットの Fargate が NAT なしで ECR イメージをプルするための VPC エンドポイント
# 参考: https://docs.aws.amazon.com/AmazonECR/latest/userguide/vpc-endpoints.html

data "aws_route_table" "private_subnet_rt" {
  for_each  = toset(var.private_subnet_ids)
  subnet_id = each.value
}

locals {
  private_subnet_route_table_ids = distinct([
    for sid in var.private_subnet_ids : data.aws_route_table.private_subnet_rt[sid].id
  ])
}

resource "aws_security_group" "vpc_endpoints" {
  name        = "${local.app_name}-vpce-sg"
  description = "Interface endpoints for ECR pull and CloudWatch Logs from ECS tasks"
  vpc_id      = var.vpc_id

  ingress {
    description     = "HTTPS from ECS task ENIs"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_service.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${local.app_name}-vpce-sg" })
}

resource "aws_vpc_endpoint" "ecr_api" {
  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.ecr.api"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.private_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = merge(local.tags, { Name = "${local.app_name}-vpce-ecr-api" })
}

resource "aws_vpc_endpoint" "ecr_dkr" {
  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.ecr.dkr"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.private_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = merge(local.tags, { Name = "${local.app_name}-vpce-ecr-dkr" })
}

resource "aws_vpc_endpoint" "logs" {
  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.logs"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.private_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = merge(local.tags, { Name = "${local.app_name}-vpce-logs" })
}

# タスク起動時に Secrets Manager から環境シークレット（JWT_SECRET 等）を取得するために必須（NAT なし構成）
resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.private_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = merge(local.tags, { Name = "${local.app_name}-vpce-secretsmanager" })
}

# app_secret_arns に SSM パラメータ（parameter/…）を使うとき、タスク起動時の GetParameters 用（NAT なし構成）
resource "aws_vpc_endpoint" "ssm" {
  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.ssm"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.private_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = merge(local.tags, { Name = "${local.app_name}-vpce-ssm" })
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = var.vpc_id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = local.private_subnet_route_table_ids

  tags = merge(local.tags, { Name = "${local.app_name}-vpce-s3" })
}
