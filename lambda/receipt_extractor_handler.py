import base64
import io
import json
import logging
import os
from typing import Any
from urllib.parse import unquote_plus

import boto3
from PIL import Image, ImageOps

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3_client = boto3.client("s3")
bedrock_client = boto3.client("bedrock-runtime")

# 既定: Claude 3.5 Sonnet（ap-northeast-1 の Bedrock で有効化が必要）
# 例: 環境変数 BEDROCK_MODEL_ID で上書き
_model_env = os.environ.get("BEDROCK_MODEL_ID", "").strip()
MODEL_ID = _model_env or "anthropic.claude-3-5-sonnet-20240620-v1:0"
MAX_EDGE = int(os.getenv("MAX_IMAGE_EDGE", "1200"))
JPEG_QUALITY = int(os.getenv("JPEG_QUALITY", "75"))
MAX_TOKENS = 400


def _load_and_optimize_image(bucket: str, key: str) -> bytes:
    """Load image from S3, resize to max edge, and compress as JPEG."""
    response = s3_client.get_object(Bucket=bucket, Key=key)
    body = response["Body"].read()
    if not body:
        raise ValueError("S3 object is empty")

    with Image.open(io.BytesIO(body)) as img:
        img = ImageOps.exif_transpose(img)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        elif img.mode == "L":
            img = img.convert("RGB")

        img.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)

        out = io.BytesIO()
        img.save(
            out,
            format="JPEG",
            quality=JPEG_QUALITY,
            optimize=True,
            progressive=True,
        )
        return out.getvalue()


def _extract_json_from_reply(reply_text: str) -> dict[str, Any]:
    text = (reply_text or "").strip()
    if not text:
        raise ValueError("Model reply is empty")

    if not text.startswith("{"):
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("Model reply does not contain JSON object")
        text = text[start : end + 1]

    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ValueError("Parsed output is not a JSON object")

    return {
        "date": parsed.get("date"),
        "total": parsed.get("total"),
        "shop_name": parsed.get("shop_name"),
    }


def _invoke_bedrock_with_image(image_jpeg: bytes) -> dict[str, Any]:
    image_b64 = base64.b64encode(image_jpeg).decode("utf-8")

    system_prompt = "レシートから情報を抽出しJSONで返せ。挨拶や説明は不要。"
    user_prompt = (
        "画像のレシートから date, total, shop_name を抽出して返してください。"
        ' JSON形式: {"date":"YYYY-MM-DD","total":0,"shop_name":"文字列"}'
    )

    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": MAX_TOKENS,
        "temperature": 0,
        "system": system_prompt,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": image_b64,
                        },
                    },
                    {"type": "text", "text": user_prompt},
                ],
            },
            # Pre-fill: force JSON object start to reduce extra text.
            {"role": "assistant", "content": [{"type": "text", "text": "{"}]},
        ],
    }

    response = bedrock_client.invoke_model(
        modelId=MODEL_ID,
        body=json.dumps(body).encode("utf-8"),
        contentType="application/json",
        accept="application/json",
    )
    payload = json.loads(response["body"].read())

    parts = payload.get("content", [])
    text_chunks = [p.get("text", "") for p in parts if p.get("type") == "text"]
    reply = "".join(text_chunks)
    if not reply.startswith("{"):
        reply = "{" + reply

    return _extract_json_from_reply(reply)


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """S3 trigger entrypoint."""
    results: list[dict[str, Any]] = []

    records = event.get("Records", []) if isinstance(event, dict) else []
    if not records:
        return {"statusCode": 400, "body": json.dumps({"error": "No S3 records in event"})}

    for record in records:
        bucket = record.get("s3", {}).get("bucket", {}).get("name")
        raw_key = record.get("s3", {}).get("object", {}).get("key")
        key = unquote_plus(raw_key) if isinstance(raw_key, str) else None

        if not bucket or not key:
            results.append(
                {
                    "ok": False,
                    "error": "InvalidS3Record",
                    "detail": {"bucket": bucket, "key": raw_key},
                }
            )
            continue

        try:
            optimized_jpeg = _load_and_optimize_image(bucket, key)
            extracted = _invoke_bedrock_with_image(optimized_jpeg)
            results.append(
                {
                    "ok": True,
                    "bucket": bucket,
                    "key": key,
                    "result": extracted,
                }
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to process receipt from s3://%s/%s", bucket, key)
            results.append(
                {
                    "ok": False,
                    "bucket": bucket,
                    "key": key,
                    "error": type(exc).__name__,
                    "message": str(exc),
                }
            )

    has_error = any(not r.get("ok") for r in results)
    status_code = 207 if has_error else 200
    return {"statusCode": status_code, "body": json.dumps({"results": results}, ensure_ascii=False)}
