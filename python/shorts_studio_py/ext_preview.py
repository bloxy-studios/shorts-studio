"""Comparison sheets for visual style choices (caption styles, layouts)."""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont


def compose(a: dict) -> dict:
    stills = a["stills"]
    labels = a.get("labels") or ["" for _ in stills]
    cols = int(a.get("cols", 3))
    tile_w = int(a.get("tileW", 360))
    font_path = a.get("fontPath")
    title = a.get("title", "")
    imgs = [Image.open(p).convert("RGB") for p in stills]
    tile_h = int(round(tile_w * imgs[0].height / imgs[0].width)) if imgs else 640
    rows = (len(imgs) + cols - 1) // cols
    header, label_h, pad = (54 if title else 0), 40, 12
    sheet = Image.new("RGB", (cols * (tile_w + pad) + pad, header + rows * (tile_h + label_h + pad) + pad), (16, 16, 18))
    draw = ImageDraw.Draw(sheet)
    f_title = ImageFont.truetype(font_path, 24) if font_path and os.path.exists(font_path) else ImageFont.load_default(24)
    f_label = ImageFont.truetype(font_path, 20) if font_path and os.path.exists(font_path) else ImageFont.load_default(20)
    if title:
        draw.text((pad, 14), title, fill=(236, 236, 236), font=f_title)
    for i, im in enumerate(imgs):
        r, c = divmod(i, cols)
        x = pad + c * (tile_w + pad)
        y = header + pad + r * (tile_h + label_h + pad)
        sheet.paste(im.resize((tile_w, tile_h), Image.Resampling.LANCZOS), (x, y))
        draw.text((x + 4, y + tile_h + 8), f"{i + 1}. {labels[i]}", fill=(230, 230, 230), font=f_label)
    os.makedirs(os.path.dirname(os.path.abspath(a["out"])), exist_ok=True)
    sheet.save(a["out"], quality=88)
    return {"path": a["out"], "tiles": len(imgs)}


COMMANDS = {"preview.compose": compose}
