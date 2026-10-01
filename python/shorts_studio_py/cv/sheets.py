"""Timestamped frame sheets for agent visual inspection and QA.

Each tile is labelled with its exact source/output time so observations written
back by the agent carry real timestamps. Sheets are sized to stay readable when
viewed as a single image (default 4 columns × 3 rows, 400 px tiles).
"""

from __future__ import annotations

import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from ..io import grab_frame


def _font(size: int, font_path: str | None) -> ImageFont.ImageFont:
    if font_path and os.path.exists(font_path):
        return ImageFont.truetype(font_path, size)
    return ImageFont.load_default(size=size)


def fmt_time(t: float) -> str:
    m = int(t // 60)
    s = t - m * 60
    return f"{m:02d}:{s:06.3f}"


def contact_sheet(
    video: str,
    times_s: list[float],
    out_path: str,
    src_w: int,
    src_h: int,
    tile_w: int = 400,
    cols: int = 4,
    title: str = "",
    labels: list[str] | None = None,
    font_path: str | None = None,
    overlays: list[list[dict]] | None = None,
) -> dict:
    """overlays[i] = list of {"box": [x,y,w,h] in source px, "color": "#RRGGBB", "label": str}."""
    tile_h = int(round(tile_w * src_h / src_w))
    tile_h -= tile_h % 2
    rows = (len(times_s) + cols - 1) // cols
    header = 44 if title else 0
    label_h = 30
    sheet = Image.new("RGB", (cols * tile_w, header + rows * (tile_h + label_h)), (18, 18, 20))
    draw = ImageDraw.Draw(sheet)
    f_title = _font(24, font_path)
    f_label = _font(18, font_path)
    if title:
        draw.text((12, 10), title, fill=(240, 240, 240), font=f_title)
    for i, t in enumerate(times_s):
        frame = grab_frame(video, t, tile_w, tile_h)
        img = Image.fromarray(frame[:, :, ::-1])
        r, c = divmod(i, cols)
        x0, y0 = c * tile_w, header + r * (tile_h + label_h)
        sheet.paste(img, (x0, y0))
        if overlays and i < len(overlays):
            sx, sy = tile_w / src_w, tile_h / src_h
            for ov in overlays[i]:
                bx, by, bw, bh = ov["box"]
                draw.rectangle([x0 + bx * sx, y0 + by * sy, x0 + (bx + bw) * sx, y0 + (by + bh) * sy], outline=ov.get("color", "#00FF88"), width=3)
                if ov.get("label"):
                    draw.text((x0 + bx * sx + 4, y0 + by * sy + 2), ov["label"], fill=ov.get("color", "#00FF88"), font=f_label)
        label = fmt_time(t) + (f"  {labels[i]}" if labels and i < len(labels) and labels[i] else "")
        draw.text((x0 + 8, y0 + tile_h + 5), label, fill=(230, 230, 230), font=f_label)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    sheet.save(out_path, quality=86)
    return {"path": out_path, "cols": cols, "rows": rows, "tileW": tile_w, "tileH": tile_h, "times": times_s}


def overview_times(duration_s: float, count: int, scene_starts: list[float] | None = None) -> list[float]:
    """Evenly spaced samples, nudged to include scene starts (scene-aware coverage)."""
    if duration_s <= 0 or count <= 0:
        return []
    base = list(np.linspace(0, duration_s, count + 2)[1:-1])
    if scene_starts:
        extra = [s + 0.5 for s in scene_starts if 0.5 < s < duration_s - 0.5]
        merged = sorted(set(round(t, 3) for t in base + extra))
        if len(merged) > count:
            idx = np.linspace(0, len(merged) - 1, count).round().astype(int)
            merged = [merged[i] for i in idx]
        return merged
    return [round(t, 3) for t in base]
