# GitHub Actions（deploy-frontend）と deploy-production.mjs が同期する静的配信バケット
# enable_legacy_spa_stack=false でも ksystemapp-web-production を Terraform で保持する

resource "aws_s3_bucket" "frontend_artifacts" {
  count  = var.manage_frontend_artifacts_bucket ? 1 : 0
  bucket = var.frontend_artifacts_bucket_name

  tags = merge(
    {
      Name        = var.frontend_artifacts_bucket_name
      Purpose     = "kakeibo-frontend-dist"
      ManagedBy   = "terraform"
    },
    var.frontend_artifacts_bucket_tags,
  )
}

resource "aws_s3_bucket_public_access_block" "frontend_artifacts" {
  count  = var.manage_frontend_artifacts_bucket ? 1 : 0
  bucket = aws_s3_bucket.frontend_artifacts[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend_artifacts" {
  count  = var.manage_frontend_artifacts_bucket ? 1 : 0
  bucket = aws_s3_bucket.frontend_artifacts[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
