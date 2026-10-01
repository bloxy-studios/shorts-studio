"""Matte quality checks and compositing masks for the Luxury Tech split layout.

Commands:
  matte.check  — temporal stability (IoU/flicker) of a person matte inside a band and
                 a frame-alignment probe against the clip it was computed from.
  matte.masks  — antialiased rounded-rect card mask and the head feather ramp (PNG).
"""

from __future__ import annotations

import subprocess

import numpy as np
from PIL import Image

from .io import ffmpeg_bin

COMMANDS: dict = {}


def _frames(path: str, vf: str, w: int, h: int, channels: int, limit: int | None = None) -> np.ndarray:
    pix = {1: "gray", 3: "rgb24"}[channels]
    cmd = [ffmpeg_bin(), "-v", "error", "-nostdin", "-i", path, "-vf", f"{vf},format={pix}", "-f", "rawvideo", "-"]
    if limit:
        cmd[6:6] = ["-frames:v", str(limit)]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    n = len(raw) // (w * h * channels)
    return np.frombuffer(raw[: n * w * h * channels], np.uint8).reshape(n, h, w, channels) if channels > 1 else np.frombuffer(raw[: n * w * h], np.uint8).reshape(n, h, w)


def check(args: dict) -> dict:
    """args: matte, clip, box {x,y,w,h} (source px band to judge), iouMin, flickerIou."""
    b = args["box"]
    x, y, w, h = (int(round(b[k])) for k in ("x", "y", "w", "h"))
    w -= w % 2
    h -= h % 2
    alpha = _frames(args["matte"], f"format=yuva444p,alphaextract,crop={w}:{h}:{x}:{y}", w, h, 1).astype(np.float32) / 255.0
    n = len(alpha)
    if n == 0:
        return {"ok": False, "frames": 0, "issues": ["matte has no frames"]}
    fg = alpha > 0.5
    cover = fg.reshape(n, -1).mean(axis=1)
    ious = []
    for i in range(1, n):
        inter = np.logical_and(fg[i], fg[i - 1]).sum()
        union = np.logical_or(fg[i], fg[i - 1]).sum()
        ious.append(1.0 if union == 0 else inter / union)
    ious_a = np.array(ious) if ious else np.array([1.0])
    # Soft-edge flicker: mean |Δα| on edge pixels between consecutive frames.
    edge = (alpha > 0.05) & (alpha < 0.95)
    flick = [float(np.abs(alpha[i] - alpha[i - 1])[edge[i] | edge[i - 1]].mean()) if (edge[i] | edge[i - 1]).any() else 0.0 for i in range(1, n)]
    iou_min = float(args.get("iouMin", 0.85))
    flicker_iou = float(args.get("flickerIou", 0.9))
    bad = int((ious_a < flicker_iou).sum())
    issues = []
    if cover.mean() < 0.01:
        issues.append("matte band is empty (no person above the card)")
    if ious_a.min() < iou_min:
        issues.append(f"matte tears/jumps: min frame-to-frame IoU {ious_a.min():.3f} < {iou_min}")
    if bad > max(2, 0.05 * n):
        issues.append(f"matte flickers: {bad}/{n - 1} transitions below IoU {flicker_iou}")
    # Alignment probe: matte RGB should match the clip frame it came from better than its neighbours.
    align = None
    if args.get("clip") and n >= 3:
        idx = [0, n // 2, n - 2]
        rgb_m = _frames(args["matte"], f"crop={w}:{h}:{x}:{y}", w, h, 3).astype(np.float32)
        rgb_c = _frames(args["clip"], f"crop={w}:{h}:{x}:{y}", w, h, 3).astype(np.float32)
        m = min(len(rgb_m), len(rgb_c))
        res = []
        for i in idx:
            if i + 1 >= m:
                continue
            mask = fg[i]
            if mask.sum() < 50:
                continue
            same = float(np.abs(rgb_m[i] - rgb_c[i])[mask].mean())
            nxt = float(np.abs(rgb_m[i] - rgb_c[i + 1])[mask].mean())
            res.append({"frame": i, "sameFrameMad": round(same, 2), "nextFrameMad": round(nxt, 2)})
        aligned = all(r["sameFrameMad"] <= r["nextFrameMad"] + 0.05 for r in res) if res else None
        align = {"probes": res, "aligned": aligned, "clipFrames": int(len(rgb_c)), "matteFrames": int(len(rgb_m))}
        if aligned is False:
            issues.append("matte frames are not aligned with the card footage")
        if len(rgb_c) != len(rgb_m):
            issues.append(f"matte has {len(rgb_m)} frames, clip has {len(rgb_c)}")
    return {
        "ok": not issues,
        "frames": n,
        "iouMean": round(float(ious_a.mean()), 4),
        "iouMin": round(float(ious_a.min()), 4),
        "edgeFlickerMean": round(float(np.mean(flick)) if flick else 0.0, 4),
        "coverage": [round(float(cover.min()), 4), round(float(cover.max()), 4)],
        "unstableTransitions": bad,
        "alignment": align,
        "issues": issues,
    }


def masks(args: dict) -> dict:
    """args: card {region {x,y,w,h}, rect {x,y,w,h,radius}, out}; ramp {w, h, y0 (canvas), featherY (card top), featherPx, out}."""
    out = {}
    c = args.get("card")
    if c:
        reg, r = c["region"], c["rect"]
        W, H = int(reg["w"]), int(reg["h"])
        ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
        px = xs + reg["x"] + 0.5
        py = ys + reg["y"] + 0.5
        rad = min(float(r["radius"]), r["w"] / 2, r["h"] / 2)
        # Signed distance to a rounded rectangle (negative inside), antialiased over 1 px.
        qx = np.abs(px - (r["x"] + r["w"] / 2)) - (r["w"] / 2 - rad)
        qy = np.abs(py - (r["y"] + r["h"] / 2)) - (r["h"] / 2 - rad)
        d = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - rad
        a = np.clip(0.5 - d, 0, 1)
        Image.fromarray((a * 255 + 0.5).astype(np.uint8), "L").save(c["out"])
        out["card"] = c["out"]
    g = args.get("ramp")
    if g:
        W, H = int(g["w"]), int(g["h"])
        # Opaque down to the card top (featherY); fades over featherPx inside the card.
        y = np.arange(H, dtype=np.float32) + g["y0"] + 0.5
        v = np.clip(1 - (y - g["featherY"]) / max(1.0, g["featherPx"]), 0, 1)
        img = np.repeat(v[:, None], W, axis=1)
        Image.fromarray((img * 255 + 0.5).astype(np.uint8), "L").save(g["out"])
        out["ramp"] = g["out"]
    return out


COMMANDS["matte.check"] = check
COMMANDS["matte.masks"] = masks
