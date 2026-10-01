"""Temporal sub-frame integration and motion-blur measurement.

Commands:
  motion.integrate — N-sample groups → one output frame with explicit shutter weights
                     (e.g. 240 fps, weights [1,1,1,0] = 3 of every 4 samples = 0.75 shutter at 60 fps),
                     averaged in linear light.
  motion.edge      — 10–90 % rise width of a vertical edge along a row, per frame (blur measurement).
"""

from __future__ import annotations

import subprocess

import numpy as np

from .io import ffmpeg_bin

COMMANDS: dict = {}


def _srgb_to_linear(x: np.ndarray) -> np.ndarray:
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(x: np.ndarray) -> np.ndarray:
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(np.clip(x, 0, None), 1 / 2.4) - 0.055)


def integrate(a: dict) -> dict:
    """args: input, output, width, height, groupSize, weights, fps (output rational string)."""
    w, h = int(a["width"]), int(a["height"])
    g = int(a.get("groupSize", 4))
    weights = np.array(a.get("weights", [1, 1, 1, 0]), dtype=np.float64)
    if len(weights) != g or weights.sum() <= 0:
        raise ValueError("weights must have groupSize entries with a positive sum")
    weights = weights / weights.sum()
    dec = subprocess.Popen([ffmpeg_bin(), "-v", "error", "-nostdin", "-i", a["input"], "-vf", "scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24", "-f", "rawvideo", "-"], stdout=subprocess.PIPE)
    enc = subprocess.Popen(
        [ffmpeg_bin(), "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", a.get("fps", "60"), "-i", "-",
         "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "10",
         "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", a["output"]],
        stdin=subprocess.PIPE,
    )
    size = w * h * 3
    out_frames = 0
    group: list[np.ndarray] = []
    assert dec.stdout and enc.stdin
    while True:
        buf = dec.stdout.read(size)
        if len(buf) < size:
            break
        group.append(_srgb_to_linear(np.frombuffer(buf, np.uint8).reshape(h, w, 3).astype(np.float64) / 255.0))
        if len(group) == g:
            acc = sum(wt * fr for wt, fr in zip(weights, group))
            enc.stdin.write((np.clip(_linear_to_srgb(acc), 0, 1) * 255 + 0.5).astype(np.uint8).tobytes())
            out_frames += 1
            group = []
    enc.stdin.close()
    enc.wait()
    dec.wait()
    return {"frames": out_frames, "leftover": len(group), "weights": weights.round(4).tolist()}


def edge(a: dict) -> dict:
    """args: video, frames [idx], y, x0, x1, width, height → per frame 10–90 % rise width (px) of the strongest edge."""
    w, h = int(a["width"]), int(a["height"])
    y, x0, x1 = int(a["y"]), int(a["x0"]), int(a["x1"])
    res = []
    for n in a["frames"]:
        raw = subprocess.run([ffmpeg_bin(), "-v", "error", "-nostdin", "-i", a["video"], "-vf", f"select=eq(n\\,{n}),scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=gray", "-frames:v", "1", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
        img = np.frombuffer(raw, np.uint8).reshape(h, w).astype(np.float64)
        row = img[max(0, y - 2) : y + 3, x0:x1].mean(axis=0)
        grad = np.abs(np.diff(row))
        k = int(np.argmax(grad))
        # Walk out from the steepest point to the plateaus on both sides.
        lo_v, hi_v = row[max(0, k - 60) : k + 1].max(), row[k : k + 61].min()
        if row[k + 1] > row[k]:
            lo_v, hi_v = row[max(0, k - 60) : k + 1].min(), row[k : k + 61].max()
        span = hi_v - lo_v
        if abs(span) < 20:
            res.append({"frame": n, "width10_90": None, "contrast": float(span)})
            continue
        t10, t90 = lo_v + 0.1 * span, lo_v + 0.9 * span
        sign = 1.0 if span > 0 else -1.0
        v = row * sign
        a10, a90 = t10 * sign, t90 * sign

        def back(i: int, thr: float) -> float:
            # last sample at or below thr walking left from i, interpolated to the crossing
            while i > 0 and v[i] > thr:
                i -= 1
            return i + (thr - v[i]) / max(1e-9, v[i + 1] - v[i])

        def fwd(i: int, thr: float) -> float:
            while i < len(v) - 1 and v[i] < thr:
                i += 1
            return i - 1 + (thr - v[i - 1]) / max(1e-9, v[i] - v[i - 1])

        x10 = back(k, a10)
        x90 = fwd(k + 1, a90)
        res.append({"frame": n, "width10_90": round(float(abs(x90 - x10)), 2), "edgeX": round(float(x0 + k), 1), "contrast": round(float(span), 1)})
    return {"edges": res}


COMMANDS["motion.integrate"] = integrate
COMMANDS["motion.edge"] = edge
