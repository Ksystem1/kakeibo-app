# 例: Terraform apply 後の site_bucket_name と cloudfront_distribution_id に置き換えて実行
# プロジェクトルートで:
#   cd c:\KsystemApp\01_kakeibo
#   .\infra\upload-dist-s3.example.ps1
#
# 重要: ./dist/ の末尾スラッシュ必須（中身だけが kakeibo/ に上がる）。
#       dist フォルダごとドラッグ＆ドロップすると kakeibo/dist/index.html になり 404 になる。

$Bucket = "YOUR_S3_BUCKET_NAME"           # terraform output -raw site_bucket_name
$DistributionId = "YOUR_CLOUDFRONT_ID"    # terraform output -raw cloudfront_distribution_id

aws s3 sync ./dist/ "s3://$Bucket/kakeibo/" --delete
aws cloudfront create-invalidation --distribution-id $DistributionId --paths "/kakeibo/*" "/*"
