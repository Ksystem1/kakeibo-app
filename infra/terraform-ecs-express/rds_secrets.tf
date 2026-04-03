# オプション: RDS 接続情報を 1 つの Secrets Manager シークレット（JSON）にまとめ、
# ECS の secrets で各キーを環境変数 RDS_* にマッピングする。
# 資格情報は state に載るため、リモート state の暗号化を必須とし、パスワードは rds-credentials.auto.tfvars 等で渡すこと。

resource "aws_secretsmanager_secret" "rds_credentials" {
  # CI 環境では rds-credentials.auto.tfvars（= rds_credentials/password）を持たないため、
  # secret 自体は常に state から維持して破棄されないよう count を固定しています。
  count                   = 1
  name                    = "${var.name_prefix}/rds/credentials"
  recovery_window_in_days = 7
  tags                    = local.tags
}

resource "aws_secretsmanager_secret_version" "rds_credentials" {
  # managed_rds_credentials_secret=false でも secret を維持し続けるため count を固定しています。
  # manage=true のときだけ secret_string を更新します。manage=false のときは既存の secret_string を参照して書き換えを抑止します。
  count     = 1
  secret_id = aws_secretsmanager_secret.rds_credentials[0].id

  secret_string = local.manage_rds_credentials ? jsonencode({
    host     = var.rds_credentials.host
    port     = tostring(var.rds_credentials.port)
    user     = var.rds_credentials.username
    password = var.rds_credentials.password
    database = var.rds_credentials.database
  }) : data.aws_secretsmanager_secret_version.rds_credentials_existing[0].secret_string
}

data "aws_secretsmanager_secret_version" "rds_credentials_existing" {
  # manage=false のときだけ既存値を参照する（secret_string をプレースホルダで上書きしない）
  count      = local.manage_rds_credentials ? 0 : 1
  secret_id  = aws_secretsmanager_secret.rds_credentials[0].id
  depends_on = [aws_secretsmanager_secret.rds_credentials]
  # AWSCURRENT を明示（プロバイダ既定でもよいが安全のため）
  version_stage = "AWSCURRENT"
}
