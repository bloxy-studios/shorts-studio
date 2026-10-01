"""Face detection (OpenCV YuNet), persistent IoU tracking, head orientation and mouth activity.

- Detection runs on frames sampled at `fps` by timestamp (VFR-safe) and scaled to
  `analysis_width`; boxes are reported in upright source pixels.
- Tracks are reset at source scene cuts so crops never interpolate across a cut.
- Head yaw/pitch come from 5-point landmarks (eyes, nose, mouth corners). This is
  head orientation evidence, not measured eye gaze; `lookingAtLens` carries a
  confidence and should be confirmed on dense frames around turns.
- Mouth activity is the normalized frame-to-frame change inside the mouth region,
  used for audiovisual speaker association (not lip reading).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

from .. import sec_to_flicks
from ..io import iter_frames


@dataclass
class Track:
    id: str
    scene: int
    samples: list[dict] = field(default_factory=list)
    last_t: float = 0.0
    last_box: tuple[float, float, float, float] = (0, 0, 0, 0)
    prev_mouth: np.ndarray | None = None
    misses: int = 0


def iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def head_pose(lm: np.ndarray) -> tuple[float, float]:
    """Approximate yaw/pitch (degrees) from YuNet landmarks [re, le, nose, mr, ml] (x,y pairs)."""
    re, le, nose, mr, ml = lm.reshape(5, 2)
    eye_mid = (re + le) / 2.0
    mouth_mid = (mr + ml) / 2.0
    eye_dist = float(np.linalg.norm(le - re)) + 1e-6
    # yaw: nose horizontal offset from the eye midpoint, normalized by inter-ocular distance
    r = float((nose[0] - eye_mid[0]) / eye_dist)
    yaw = math.degrees(math.asin(max(-1.0, min(1.0, r / 0.62))))
    # pitch: nose position between the eye line and the mouth line (≈0.5 when level)
    span = float(mouth_mid[1] - eye_mid[1]) + 1e-6
    v = float((nose[1] - eye_mid[1]) / span)
    pitch = (v - 0.55) * 90.0
    return yaw, pitch


def mouth_patch(gray: np.ndarray, lm: np.ndarray) -> np.ndarray | None:
    re, le, nose, mr, ml = lm.reshape(5, 2)
    eye_dist = float(np.linalg.norm(le - re))
    if eye_dist < 6:
        return None
    x0 = int(min(mr[0], ml[0]) - 0.15 * eye_dist)
    x1 = int(max(mr[0], ml[0]) + 0.15 * eye_dist)
    y0 = int((nose[1] + min(mr[1], ml[1])) / 2)
    y1 = int(max(mr[1], ml[1]) + 0.45 * eye_dist)
    h, w = gray.shape
    x0, x1, y0, y1 = max(0, x0), min(w, x1), max(0, y0), min(h, y1)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    return cv2.resize(gray[y0:y1, x0:x1], (32, 16), interpolation=cv2.INTER_AREA).astype(np.float32)


def track_faces(
    video: str,
    model_path: str,
    src_w: int,
    src_h: int,
    fps: float = 5.0,
    analysis_width: int = 640,
    start_s: float = 0.0,
    dur_s: float | None = None,
    scene_cuts_s: list[float] | None = None,
    score_threshold: float = 0.7,
    max_gap_s: float = 1.2,
    lens_yaw_deg: float = 16.0,
    lens_pitch_deg: float = 20.0,
) -> dict:
    aw = analysis_width
    ah = int(round(aw * src_h / src_w))
    ah -= ah % 2
    scale = src_w / aw
    det = cv2.FaceDetectorYN.create(model_path, "", (aw, ah), score_threshold, 0.3, 50)
    cuts = sorted(scene_cuts_s or [])
    tracks: list[Track] = []
    active: list[Track] = []
    frames = 0
    scene = 0
    next_id = 1

    for t, frame in iter_frames(video, fps, aw, ah, start_s, dur_s):
        frames += 1
        while scene < len(cuts) and t >= cuts[scene]:
            scene += 1
            active = []  # reset at scene cuts
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        _, faces = det.detect(frame)
        dets = []
        if faces is not None:
            for f in faces:
                box = (float(f[0] * scale), float(f[1] * scale), float(f[2] * scale), float(f[3] * scale))
                lm_small = np.array(f[4:14], dtype=np.float64)
                dets.append((box, lm_small * scale, float(f[14]), lm_small))
        # Hungarian assignment on (1 - IoU)
        if active and dets:
            cost = np.array([[1.0 - iou(tr.last_box, d[0]) for d in dets] for tr in active])
            rows, cols = linear_sum_assignment(cost)
            pairs = [(r, c) for r, c in zip(rows, cols) if cost[r, c] < 0.7]
        else:
            pairs = []
        matched_t = {r for r, _ in pairs}
        matched_d = {c for _, c in pairs}
        for r, c in pairs:
            _add_sample(active[r], t, dets[c], gray, lens_yaw_deg, lens_pitch_deg)
        for i, d in enumerate(dets):
            if i in matched_d:
                continue
            tr = Track(id=f"T{next_id}", scene=scene)
            next_id += 1
            _add_sample(tr, t, d, gray, lens_yaw_deg, lens_pitch_deg)
            tracks.append(tr)
            active.append(tr)
        for idx, tr in enumerate(active):
            if idx not in matched_t and tr.samples and tr.samples[-1]["tSec"] != t:
                tr.misses += 1
        active = [tr for tr in active if t - tr.last_t <= max_gap_s]

    out_tracks = []
    period = 1.0 / fps
    for tr in tracks:
        if len(tr.samples) < 2:
            continue
        t0 = tr.samples[0]["tSec"]
        t1 = tr.samples[-1]["tSec"] + period
        expected = max(1, int(round((t1 - t0) * fps)))
        boxes = np.array([[s["box"]["x"], s["box"]["y"], s["box"]["w"], s["box"]["h"]] for s in tr.samples], dtype=np.float64)
        mean_box = boxes.mean(axis=0)
        centers = boxes[:, :2] + boxes[:, 2:] / 2
        jitter = float(np.std(np.diff(centers, axis=0), axis=0).mean()) if len(centers) > 2 else 0.0
        out_tracks.append(
            {
                "id": tr.id,
                "sceneIndex": tr.scene,
                "start": sec_to_flicks(t0),
                "end": sec_to_flicks(t1),
                "visibility": round(min(1.0, len(tr.samples) / expected), 3),
                "meanBox": {"x": float(mean_box[0]), "y": float(mean_box[1]), "w": float(mean_box[2]), "h": float(mean_box[3])},
                "centerJitterPx": round(jitter, 2),
                "samples": [{k: v for k, v in s.items() if k != "tSec"} | {"t": sec_to_flicks(s["tSec"])} for s in tr.samples],
            }
        )
    return {
        "detector": {"name": "opencv-yunet", "model": model_path.split("/")[-1], "version": cv2.__version__},
        "sampling": {"baseFps": fps, "framesAnalyzed": frames, "analysisWidth": aw},
        "frame": {"width": src_w, "height": src_h},
        "tracks": out_tracks,
    }


def _add_sample(tr: Track, t: float, det: tuple, gray: np.ndarray, lens_yaw: float, lens_pitch: float) -> None:
    box, lm_src, score, lm_small = det
    yaw, pitch = head_pose(lm_src)
    patch = mouth_patch(gray, lm_small)
    activity = None
    if patch is not None and tr.prev_mouth is not None:
        activity = float(np.mean(np.abs(patch - tr.prev_mouth)) / (np.std(patch) + 8.0))
    tr.prev_mouth = patch
    # looking-at-lens evidence from head orientation, with confidence falling near the thresholds
    margin_yaw = (lens_yaw - abs(yaw)) / lens_yaw
    margin_pitch = (lens_pitch - abs(pitch)) / lens_pitch
    looking = margin_yaw > 0 and margin_pitch > 0
    conf = float(min(0.85, 0.5 + 0.5 * min(abs(margin_yaw), abs(margin_pitch))))
    tr.samples.append(
        {
            "tSec": t,
            "box": {"x": box[0], "y": box[1], "w": box[2], "h": box[3]},
            "score": round(score, 3),
            "landmarks": [round(float(v), 1) for v in lm_src],
            "yawDeg": round(yaw, 1),
            "pitchDeg": round(pitch, 1),
            "lookingAtLens": {"value": bool(looking), "confidence": round(conf, 2)},
            **({"mouthActivity": round(activity, 4)} if activity is not None else {}),
        }
    )
    tr.last_t = t
    tr.last_box = box
    tr.misses = 0
