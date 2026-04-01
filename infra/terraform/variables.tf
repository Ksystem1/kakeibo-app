variable "aws_region" {
  type        = string
  description = "S3 / Route53 レコードなど（東京推奨）"
  default     = "ap-northeast-1"
}

variable "root_domain" {
  type        = string
  description = "登録ドメイン（例: ksystemapp.com）"
  default     = "ksystemapp.com"
}

variable "app_path_prefix" {
  type        = string
  description = "ブラウザパス（先頭スラなし禁止。既定 kakeibo → https://<domain>/kakeibo/）"
  default     = "kakeibo"
}

variable "api_subdomain" {
  type        = string
  description = "API 用サブドメイン（例 api → api.ksystemapp.com）"
  default     = "api"
}

variable "enable_legacy_spa_stack" {
  type        = bool
  description = "true のときのみ legacy SPA (S3/CloudFront/Route53/ACM) を作成"
  default     = false
}

variable "create_hosted_zone" {
  type        = bool
  description = "false にすると既存ゾーン ID を zone_id に指定（ドメイン登録済みで別スタックが作ったゾーンなど）"
  default     = true
}

variable "existing_zone_id" {
  type        = string
  description = "create_hosted_zone=false のとき任意。空なら root_domain 名でパブリックゾーンを自動参照"
  default     = ""
}

variable "include_www_alias" {
  type        = bool
  description = "CloudFront / ACM に www.<root> を含め、A/AAAA レコードを作成する"
  default     = false
}
