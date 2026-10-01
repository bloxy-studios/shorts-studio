"""Source-wide audio features: 10 ms RMS envelope, energy VAD, pauses, noise floor, and events.

The envelope is RMS in dBFS where full scale = amplitude 1.0 (a full-scale sine
reads -3.01 dBFS). VAD here is an adaptive energy detector with hysteresis; it is
a measurement aid, not a language model, and its engine name is reported.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import maximum_filter1d, uniform_filter1d

from .. import sec_to_flicks
from .loudness import measure

FLOOR_DB = -100.0


def rms_envelope(x: np.ndarray, rate: int, window_ms: float = 10.0) -> np.ndarray:
    hop = max(1, int(round(rate * window_ms / 1000.0)))
    n = len(x) // hop
    if n == 0:
        return np.array([FLOOR_DB])
    frames = x[: n * hop].reshape(n, hop)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    with np.errstate(divide="ignore"):
        db = 20.0 * np.log10(np.maximum(rms, 1e-10))
    return np.maximum(db, FLOOR_DB)


def speech_regions(env_db: np.ndarray, window_ms: float, min_speech_ms: float = 120, min_gap_ms: float = 180, margin_db: float = 12.0) -> tuple[list[tuple[int, int]], float, float]:
    """Hysteresis energy VAD on the envelope. Returns (regions as window index ranges, floor, threshold)."""
    finite = env_db[env_db > FLOOR_DB + 1]
    floor = float(np.percentile(finite, 10)) if finite.size else FLOOR_DB
    loud = float(np.percentile(finite, 95)) if finite.size else FLOOR_DB
    on_thr = max(floor + margin_db, min(loud - 25.0, -45.0), -60.0)
    off_thr = on_thr - 4.0
    smooth = uniform_filter1d(env_db, size=3)
    active = np.zeros_like(smooth, dtype=bool)
    state = False
    for i, v in enumerate(smooth):
        if not state and v >= on_thr:
            state = True
        elif state and v < off_thr:
            state = False
        active[i] = state
    regions: list[tuple[int, int]] = []
    i = 0
    n = len(active)
    while i < n:
        if active[i]:
            j = i
            while j < n and active[j]:
                j += 1
            regions.append((i, j))
            i = j
        else:
            i += 1
    min_gap = int(round(min_gap_ms / window_ms))
    merged: list[tuple[int, int]] = []
    for r in regions:
        if merged and r[0] - merged[-1][1] < min_gap:
            merged[-1] = (merged[-1][0], r[1])
        else:
            merged.append(r)
    min_len = int(round(min_speech_ms / window_ms))
    return [r for r in merged if r[1] - r[0] >= min_len], floor, on_thr


def analyze(samples: np.ndarray, rate: int, window_ms: float = 10.0) -> dict:
    env = rms_envelope(samples, rate, window_ms)
    regions, floor, thr = speech_regions(env, window_ms)
    w = window_ms / 1000.0
    speech = [{"start": sec_to_flicks(a * w), "end": sec_to_flicks(b * w)} for a, b in regions]
    pauses = []
    for (a0, a1), (b0, _b1) in zip(regions, regions[1:]):
        if (b0 - a1) * w >= 0.15:
            pauses.append({"start": sec_to_flicks(a1 * w), "end": sec_to_flicks(b0 * w)})

    events = []
    # Energy peaks: local maxima of the 200 ms-smoothed envelope in the top 3% of speech energy.
    if regions:
        smooth = uniform_filter1d(env, size=max(1, int(0.2 / w)))
        in_speech = np.zeros_like(env, dtype=bool)
        for a, b in regions:
            in_speech[a:b] = True
        if in_speech.any():
            hi = float(np.percentile(smooth[in_speech], 97))
            peaks = (smooth == maximum_filter1d(smooth, size=max(1, int(1.5 / w)))) & (smooth >= hi) & in_speech
            for idx in np.flatnonzero(peaks)[:200]:
                events.append({"t": sec_to_flicks(idx * w), "kind": "energy-peak", "confidence": 0.5, "detail": f"{smooth[idx]:.1f} dBFS (200 ms mean)"})
    for (p0, p1) in [(p["start"], p["end"]) for p in pauses]:
        if (p1 - p0) / 705_600_000 >= 1.2:
            events.append({"t": p0, "end": p1, "kind": "long-pause", "confidence": 0.9, "detail": f"{(p1 - p0) / 705_600_000:.2f} s below speech threshold"})
    # Clipping: runs of >= 3 consecutive samples at |x| >= 0.999.
    clipped = np.abs(samples) >= 0.999
    if clipped.any():
        runs = np.flatnonzero(np.diff(np.concatenate(([0], clipped.astype(np.int8), [0]))) == 1)
        for start in runs[:100]:
            if clipped[start : start + 3].all():
                events.append({"t": sec_to_flicks(start / rate), "kind": "clipping", "confidence": 0.95, "detail": "consecutive full-scale samples"})
    # Laughter candidates: 3-7 Hz energy modulation bursts with high envelope variance (heuristic only).
    events.extend(_laughter_candidates(env, w, regions))
    loud = measure(samples, rate)
    return {
        "envelope": [round(float(v), 2) for v in env],
        "speech": speech,
        "pauses": pauses,
        "noiseFloorDbfs": round(floor, 2),
        "speechThresholdDbfs": round(thr, 2),
        "loudness": {"integratedLufs": loud["integratedLufs"], "truePeakDbtp": loud["truePeakDbtp"], "lraLu": None},
        "events": sorted(events, key=lambda e: e["t"]),
        "vadEngine": "energy-hysteresis-v1",
    }


def _laughter_candidates(env: np.ndarray, w: float, regions: list[tuple[int, int]]) -> list[dict]:
    out = []
    win = int(round(1.0 / w))
    if len(env) < win * 2:
        return out
    lin = 10 ** (env / 20.0)
    for a, b in regions:
        for s in range(a, max(a + 1, b - win), win // 2):
            seg = lin[s : s + win]
            if len(seg) < win:
                continue
            seg = seg - seg.mean()
            spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
            freqs = np.fft.rfftfreq(len(seg), d=w)
            band = (freqs >= 3.0) & (freqs <= 7.0)
            total = spec[(freqs > 0.5) & (freqs < 20)].sum() + 1e-9
            ratio = float(spec[band].sum() / total)
            if ratio > 0.62:
                out.append({
                    "t": sec_to_flicks(s * w),
                    "end": sec_to_flicks((s + win) * w),
                    "kind": "laughter-candidate",
                    "confidence": round(min(0.5, ratio - 0.3), 2),
                    "detail": f"rhythmic 3-7 Hz energy modulation ratio {ratio:.2f} (heuristic; verify in transcript/frames)",
                })
    return out
