# Receipt Extractor Lambda

AWS Lambda (`python3.12` / `arm64`) that triggers on S3 upload, compresses receipt images with Pillow, and extracts `date/total/shop_name` using Amazon Bedrock Claude 3.5 Haiku.

## Files

- `receipt_extractor_handler.py`: Lambda handler
- `requirements.txt`: Python dependencies
- `template.yaml`: AWS SAM template

## Deploy (AWS SAM)

From `lambda/` directory:

```bash
sam build
sam deploy --guided
```

Recommended guided inputs:

- Stack name: `receipt-extractor-haiku`
- Region: your Bedrock-enabled region (for example `ap-northeast-1`)
- Parameter `SourceBucketName`: your upload bucket
- Parameter `SourcePrefix`: for example `receipts/`

## Notes

- Model ID is fixed to:
  - `anthropic.claude-3-5-haiku-20241022-v1:0`
- Cost/speed controls:
  - max edge resize: `MAX_IMAGE_EDGE` (default `1200`)
  - JPEG quality: `JPEG_QUALITY` (default `75`)
  - Bedrock `max_tokens`: `400`
- Ensure your AWS account has Bedrock access to Claude 3.5 Haiku.
