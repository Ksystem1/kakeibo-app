# オプション: RDS 接続情報を 1 つの Secrets Manager シークレット（JSON）にまとめ、
# ECS の secrets で各キーを環境変数 RDS_* にマッピングする。
# 資格情報は state に載るため、リモート state の暗号化を必須とし、パスワードは rds-credentials.auto.tfvars 等で渡すこと。

resource "aws_secretsmanager_secret" "rds_credentials" {
  count                   = local.manage_rds_credentials ? 1 : 0
  name                    = "${var.name_prefix}/rds/credentials"
  recovery_window_in_days = 7
  tags                    = local.tags
}

resource "aws_secretsmanager_secret_version" "rds_credentials" {
  count         = local.manage_rds_credentials ? 1 : 0
  secret_id     = aws_secretsmanager_secret.rds_credentials[0].id
  secret_string = jsonencode({
    host     = var.rds_credentials.host
    port     = tostring(var.rds_credentials.port)
    user     = var.rds_credentials.username
    password = var.rds_credentials.password
    database = var.rds_credentials.database
  })
}
