#!/usr/bin/env python3
"""
Instagram 集客向けの広告文を自動生成して保存するスクリプト。

主な機能:
- 日替わり（deterministic）またはランダムでキャッチコピーを生成
- 広告文 (`ad_output.txt`) と画像生成向けプロンプト (`image_prompt.txt`) を出力
- Zapier/Make 連携向けに指定ディレクトリへ保存
- 任意で Google Drive 同期フォルダへ同時コピー

機密情報:
- API キー等はコードに書かず、必要なら環境変数から読み取る設計
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import random
import shutil
from pathlib import Path
from typing import Any


DEFAULT_CONFIG = Path("ad_config.json")
DEFAULT_OUTPUT_DIR = Path("automation_output")
DEFAULT_AD_FILE = "ad_output.txt"
DEFAULT_PROMPT_FILE = "image_prompt.txt"
DEFAULT_CAPTION_FILE = "caption_output.txt"
DEFAULT_META_FILE = "ad_meta.json"


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        raise ValueError("設定ファイルの形式が不正です（JSON object が必要）")
    return raw


def choose_index(length: int, mode: str, day_key: str | None) -> int:
    if length <= 0:
        raise ValueError("選択候補がありません")
    if mode == "random":
        return random.randrange(length)
    if mode == "daily":
        key = day_key or dt.date.today().isoformat()
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        return int(digest[:8], 16) % length
    raise ValueError(f"未対応の mode です: {mode}")


def render_text(template: str, values: dict[str, str]) -> str:
    out = template
    for k, v in values.items():
        out = out.replace("{" + k + "}", v)
    return out


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def write_text(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def copy_to_dir(src_files: list[Path], dst_dir: Path) -> None:
    ensure_dir(dst_dir)
    for src in src_files:
        shutil.copy2(src, dst_dir / src.name)


def normalize_spaces(text: str) -> str:
    lines = [ln.rstrip() for ln in text.splitlines()]
    return "\n".join(lines).strip()


def trim_caption_to_max_length(caption: str, max_len: int) -> str:
    if max_len <= 0 or len(caption) <= max_len:
        return caption
    lines = caption.splitlines()
    if not lines:
        return caption[:max_len]

    hashtag_line = ""
    body_lines = lines
    if lines and lines[-1].lstrip().startswith("#"):
        hashtag_line = lines[-1].strip()
        body_lines = lines[:-1]

    body = "\n".join(body_lines).strip()
    suffix = "..."

    reserve = len(suffix)
    if hashtag_line:
        reserve += 2 + len(hashtag_line)  # "\n\n" + hashtag_line

    keep = max_len - reserve
    if keep < 1:
        # ハッシュタグを全部残せないケースは本文優先で切る
        return caption[: max(0, max_len - len(suffix))].rstrip() + suffix

    trimmed_body = body[:keep].rstrip()
    out = f"{trimmed_body}{suffix}"
    if hashtag_line:
        out = f"{out}\n\n{hashtag_line}"
    return out


def ensure_caption_min_length(caption: str, min_len: int, cta: str) -> str:
    if min_len <= 0 or len(caption) >= min_len:
        return caption
    filler = f"\n\n{cta}".strip()
    out = caption
    while len(out) < min_len:
        out = f"{out}\n{filler}".strip()
        if len(filler) == 0:
            break
    return out


def build_outputs(
    cfg: dict[str, Any], mode: str, day_key: str | None
) -> tuple[str, str, str, dict[str, Any]]:
    hooks = list(cfg.get("hooks", []))
    benefits = list(cfg.get("benefits", []))
    ctas = list(cfg.get("ctas", []))
    hashtags = list(cfg.get("hashtags", []))
    caption_hashtags = list(cfg.get("caption_hashtags", hashtags))
    caption_emojis = list(cfg.get("caption_emojis", ["✨", "📊", "💰", "📱", "🌿"]))
    caption_templates = list(
        cfg.get(
            "caption_templates",
            [
                "{emoji} {hook}\n{emoji2} {benefit}\n{cta}\n\n{hashtags_line}",
                "{emoji} 今日の家計管理ヒント\n{hook}\n\n{benefit}\n{cta}\n\n{hashtags_line}",
                "{emoji} {service_name}\n{hook}\n{emoji2} {benefit}\n{cta}\n\n{hashtags_line}",
            ],
        )
    )
    prompt_templates = list(cfg.get("image_prompt_templates", []))
    service_name = str(cfg.get("service_name", "家計簿アプリ")).strip() or "家計簿アプリ"

    if not hooks or not benefits or not ctas:
        raise ValueError("hooks / benefits / ctas は最低1件ずつ必要です")
    if not prompt_templates:
        prompt_templates = [
            "{service_name} の Instagram 広告画像。明るい配色、スマホ画面、節約アイコン、日本語UIを想起させるデザイン。キャッチコピー: {hook}",
        ]

    hook = hooks[choose_index(len(hooks), mode, (day_key or "") + ":hook")]
    benefit = benefits[choose_index(len(benefits), mode, (day_key or "") + ":benefit")]
    cta = ctas[choose_index(len(ctas), mode, (day_key or "") + ":cta")]
    caption_template = caption_templates[
        choose_index(len(caption_templates), mode, (day_key or "") + ":caption")
    ]
    emoji = str(caption_emojis[choose_index(len(caption_emojis), mode, (day_key or "") + ":emoji")])
    emoji2 = str(caption_emojis[choose_index(len(caption_emojis), mode, (day_key or "") + ":emoji2")])
    prompt_template = prompt_templates[choose_index(len(prompt_templates), mode, (day_key or "") + ":prompt")]

    values = {
        "service_name": service_name,
        "hook": str(hook),
        "benefit": str(benefit),
        "cta": str(cta),
        "emoji": emoji,
        "emoji2": emoji2,
        "hashtags_line": " ".join(str(x) for x in caption_hashtags),
    }

    body_template = str(
        cfg.get(
            "ad_template",
            "{hook}\n\n{service_name}なら、{benefit}\n{cta}",
        )
    )
    ad_text = render_text(body_template, values)
    if hashtags:
        ad_text = f"{ad_text}\n\n" + " ".join(str(x) for x in hashtags)

    caption_text = render_text(str(caption_template), values)
    caption_text = normalize_spaces(caption_text)
    caption_min_len = int(cfg.get("caption_min_length", 0) or 0)
    caption_max_len = int(cfg.get("caption_max_length", 0) or 0)
    caption_text = ensure_caption_min_length(caption_text, caption_min_len, str(cta))
    caption_text = trim_caption_to_max_length(caption_text, caption_max_len)
    prompt_text = render_text(str(prompt_template), values)
    meta = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "mode": mode,
        "day_key": day_key or dt.date.today().isoformat(),
        "values": values,
        "caption_length": len(caption_text),
        "caption_min_length": caption_min_len,
        "caption_max_length": caption_max_len,
    }
    return ad_text, prompt_text, caption_text, meta


def main() -> None:
    parser = argparse.ArgumentParser(description="Instagram広告文の自動生成")
    parser.add_argument("--config", default=os.getenv("AD_CONFIG_PATH", str(DEFAULT_CONFIG)))
    parser.add_argument(
        "--mode",
        choices=["daily", "random"],
        default=os.getenv("AD_SELECTION_MODE", "daily"),
        help="daily: 日替わり固定 / random: ランダム",
    )
    parser.add_argument("--day-key", default=os.getenv("AD_DAY_KEY", ""), help="daily選択用キー（省略時は今日の日付）")
    args = parser.parse_args()

    cfg_path = Path(args.config)
    output_dir = Path(os.getenv("AD_OUTPUT_DIR", str(DEFAULT_OUTPUT_DIR)))
    google_drive_dir_raw = os.getenv("GOOGLE_DRIVE_EXPORT_DIR", "").strip()
    google_drive_dir = Path(google_drive_dir_raw) if google_drive_dir_raw else None

    cfg = load_config(cfg_path)
    ad_text, prompt_text, caption_text, meta = build_outputs(cfg, args.mode, args.day_key or None)

    ensure_dir(output_dir)
    ad_file = output_dir / str(cfg.get("ad_output_file", DEFAULT_AD_FILE))
    prompt_file = output_dir / str(cfg.get("prompt_output_file", DEFAULT_PROMPT_FILE))
    caption_file = output_dir / str(cfg.get("caption_output_file", DEFAULT_CAPTION_FILE))
    meta_file = output_dir / str(cfg.get("meta_output_file", DEFAULT_META_FILE))

    write_text(ad_file, ad_text + "\n")
    write_text(prompt_file, prompt_text + "\n")
    write_text(caption_file, caption_text + "\n")
    write_text(meta_file, json.dumps(meta, ensure_ascii=False, indent=2) + "\n")

    copied_to_drive = False
    if google_drive_dir is not None:
        copy_to_dir([ad_file, prompt_file, caption_file, meta_file], google_drive_dir)
        copied_to_drive = True

    print(
        json.dumps(
            {
                "ok": True,
                "config": str(cfg_path),
                "mode": args.mode,
                "output_dir": str(output_dir),
                "ad_output": str(ad_file),
                "prompt_output": str(prompt_file),
                "caption_output": str(caption_file),
                "meta_output": str(meta_file),
                "copied_to_google_drive_dir": copied_to_drive,
                "google_drive_dir": str(google_drive_dir) if google_drive_dir else None,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

