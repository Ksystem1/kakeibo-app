#!/usr/bin/env python3
"""
public/skins/*/ のナビ PNG について、画像外周の白〜薄灰（低彩度・高明度）を透明化する。
エッジから BFS し、カプセル内部の色とは連結しない前提で外枠のみ除去する。
"""
from __future__ import annotations

import sys
from collections import deque
from pathlib import Path

from PIL import Image


def is_background_like(r: int, g: int, b: int) -> bool:
    """白ボックス・薄いグレーの枠線を背景扱い（カラフルな本体は除外しやすいように彩度で切る）。"""
    mx, mn = max(r, g, b), min(r, g, b)
    sat = mx - mn
    lum = (r + g + b) / 3.0
    # ほぼ白
    if r >= 245 and g >= 245 and b >= 245:
        return True
    # 薄い無彩色〜ごく弱い色味（枠線・抗アリエイジングの灰）
    if sat <= 42 and lum >= 158:
        return True
    return False


def flood_transparent_edge(img: Image.Image) -> Image.Image:
    rgba = img.convert("RGBA")
    w, h = rgba.size
    px = rgba.load()

    visited = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()

    def enqueue(x: int, y: int) -> None:
        if x < 0 or x >= w or y < 0 or y >= h or visited[y][x]:
            return
        r, g, b, a = px[x, y]
        if a == 0:
            return
        if not is_background_like(r, g, b):
            return
        visited[y][x] = True
        q.append((x, y))

    for x in range(w):
        enqueue(x, 0)
        enqueue(x, h - 1)
    for y in range(h):
        enqueue(0, y)
        enqueue(w - 1, y)

    while q:
        x, y = q.popleft()
        r, g, b, _ = px[x, y]
        px[x, y] = (r, g, b, 0)
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if nx < 0 or nx >= w or ny < 0 or ny >= h or visited[ny][nx]:
                continue
            r2, g2, b2, a2 = px[nx, ny]
            if a2 == 0:
                continue
            if is_background_like(r2, g2, b2):
                visited[ny][nx] = True
                q.append((nx, ny))

    return rgba


def main() -> int:
    skins_root = Path(__file__).resolve().parents[1] / "public" / "skins"
    if not skins_root.is_dir():
        print(f"Missing: {skins_root}", file=sys.stderr)
        return 1

    target_ids = sys.argv[1:] if len(sys.argv) > 1 else ["Tmp01"]
    for skin_id in target_ids:
        root = skins_root / skin_id
        if not root.is_dir():
            print(f"Skip (missing): {root}")
            continue

        pngs = sorted(root.glob("*.png"))
        if not pngs:
            print(f"Skip (no png): {root}")
            continue

        for path in pngs:
            im = Image.open(path)
            out = flood_transparent_edge(im)
            out.save(path, format="PNG", optimize=True)
            print(f"OK {skin_id}/{path.name}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
