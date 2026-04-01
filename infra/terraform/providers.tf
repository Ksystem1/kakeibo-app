# メインリソース（東京）
provider "aws" {
  region = var.aws_region
}

# CloudFront 用 ACM は us-east-1 必須
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}
