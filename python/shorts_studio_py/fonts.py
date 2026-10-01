"""Glyph advance tables for bundled fonts, so caption grouping can measure text widths.

Variable fonts are instanced at the requested weight (fontTools.varLib.instancer)
so bold widths are real, not scaled guesses. Kerning is ignored; callers keep a
small safety margin and QA verifies rendered text bounds on actual frames.
"""

from __future__ import annotations

import io

from fontTools.ttLib import TTFont

# ASCII, Latin-1, Latin Extended-A, general punctuation, currency.
CHARSET = [chr(c) for c in list(range(0x20, 0x7F)) + list(range(0xA0, 0x180)) + list(range(0x2010, 0x2040)) + [0x20AC, 0x2122]]


def face_metrics(path: str, weight: int | None = None) -> dict:
    font = TTFont(path)
    if "fvar" in font:
        from fontTools.varLib.instancer import instantiateVariableFont

        axes = {a.axisTag: a.defaultValue for a in font["fvar"].axes}
        if weight is not None and "wght" in axes:
            axes["wght"] = float(weight)
        font = instantiateVariableFont(font, axes, inplace=False)
        # round-trip so hmtx reflects the instance
        buf = io.BytesIO()
        font.save(buf)
        buf.seek(0)
        font = TTFont(buf)
    upm = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    advances = {}
    for ch in CHARSET:
        glyph = cmap.get(ord(ch))
        if glyph is not None:
            advances[ch] = hmtx[glyph][0]
    os2 = font["OS/2"]
    space = advances.get(" ", upm // 4)
    avg = sum(advances.values()) / max(1, len(advances))
    return {
        "unitsPerEm": upm,
        "ascender": os2.sTypoAscender,
        "descender": os2.sTypoDescender,
        "capHeight": getattr(os2, "sCapHeight", None),
        "xHeight": getattr(os2, "sxHeight", None),
        "advances": advances,
        "fallbackAdvance": round(avg, 1),
        "space": space,
    }


def build(faces: list[dict]) -> dict:
    """faces: [{"key": "Poppins|700|normal", "file": "/abs/Poppins-Bold.ttf", "weight": 700}]"""
    return {f["key"]: face_metrics(f["file"], f.get("weight")) for f in faces}
