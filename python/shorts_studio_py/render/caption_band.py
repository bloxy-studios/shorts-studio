"""Frame-exact caption overlay from a HyperFrames state sheet.

Input: state PNGs (frame_000001.png = state 0), a run-length schedule mapping
output frames to (state, scale, dy, opacity), the output frame count and fps.
Output: a lossless RGBA band video (QuickTime RLE) covering only the vertical
band where captions ever appear, plus per-state text bounds for QA.

Transforms resample in premultiplied alpha so stroked text never gains dark
fringes; translations are whole pixels (exact).
"""

from __future__ import annotations

import os
import subprocess

import numpy as np
from PIL import Image

from ..io import ffmpeg_bin


def _alpha_bbox(a: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(a > 8)
    if ys.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def build_band(frames_dir: str, runs: list[dict], frame_count: int, fps_num: int, fps_den: int, out_path: str, canvas_w: int, canvas_h: int, margin: int = 48) -> dict:
    files = sorted(f for f in os.listdir(frames_dir) if f.startswith("frame_") and f.endswith(".png"))
    states = [np.asarray(Image.open(os.path.join(frames_dir, f)).convert("RGBA")) for f in files]
    if not states:
        raise RuntimeError(f"no state frames in {frames_dir}")
    bounds = [_alpha_bbox(s[:, :, 3]) for s in states]
    present = [b for b in bounds if b]
    if not present:
        raise RuntimeError("all caption states are empty (fonts missing or text outside the canvas?)")
    y0 = max(0, min(b[1] for b in present) - margin)
    y1 = min(canvas_h, max(b[3] for b in present) + margin)
    y0 -= y0 % 2
    if (y1 - y0) % 2:
        y1 = min(canvas_h, y1 + 1) if y1 < canvas_h else y1 - 1
    band_h = y1 - y0
    bands = [s[y0:y1].copy() for s in states]
    empty = np.zeros((band_h, canvas_w, 4), dtype=np.uint8)

    def transformed(idx: int, scale: float, dy: int, opacity: float) -> np.ndarray:
        img = bands[idx]
        b = bounds[idx]
        if scale != 1.0 and b:
            cx = (b[0] + b[2]) / 2.0
            cy = (b[1] + b[3]) / 2.0 - y0
            pim = Image.fromarray(img, "RGBA").convert("RGBa")
            inv = 1.0 / scale
            # output (x,y) samples input (cx + (x-cx)/s, cy + (y-cy)/s)
            coeffs = (inv, 0, cx - cx * inv, 0, inv, cy - cy * inv)
            pim = pim.transform(pim.size, Image.Transform.AFFINE, coeffs, resample=Image.Resampling.BICUBIC)
            img = np.asarray(pim.convert("RGBA"))
        if dy:
            shifted = np.zeros_like(img)
            if dy > 0:
                shifted[dy:] = img[:-dy]
            else:
                shifted[:dy] = img[-dy:]
            img = shifted
        if opacity < 1.0:
            img = img.copy()
            img[:, :, 3] = (img[:, :, 3].astype(np.float32) * opacity + 0.5).astype(np.uint8)
        return img

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    tmp = out_path + ".partial.mov"
    cmd = [
        ffmpeg_bin(), "-hide_banner", "-nostdin", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{canvas_w}x{band_h}", "-framerate", f"{fps_num}/{fps_den}", "-i", "-",
        "-c:v", "qtrle", "-pix_fmt", "argb", tmp,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdin is not None
    runs_sorted = sorted(runs, key=lambda r: r["start"])
    ri = 0
    cache_key = None
    cache_bytes = empty.tobytes()
    shown = 0
    try:
        for k in range(frame_count):
            while ri < len(runs_sorted) and runs_sorted[ri]["end"] <= k:
                ri += 1
            run = runs_sorted[ri] if ri < len(runs_sorted) and runs_sorted[ri]["start"] <= k else None
            if run is None:
                key = None
            else:
                f = run["frame"]
                key = (f["state"], f["scale"], f["dy"], f["opacity"])
                shown += 1
            if key != cache_key:
                cache_key = key
                cache_bytes = empty.tobytes() if key is None else transformed(key[0], float(key[1]), int(key[2]), float(key[3])).tobytes()
            proc.stdin.write(cache_bytes)
        proc.stdin.close()
    except BrokenPipeError:
        pass
    err = proc.stderr.read().decode() if proc.stderr else ""
    if proc.wait() != 0:
        raise RuntimeError(f"ffmpeg band encode failed: {err[-1500:]}")
    os.replace(tmp, out_path)
    return {
        "path": out_path,
        "bandY": y0,
        "bandHeight": band_h,
        "width": canvas_w,
        "frames": frame_count,
        "framesWithCaption": shown,
        "stateBounds": [
            ({"x0": b[0], "y0": b[1], "x1": b[2], "y1": b[3]} if b else None) for b in bounds
        ],
    }
