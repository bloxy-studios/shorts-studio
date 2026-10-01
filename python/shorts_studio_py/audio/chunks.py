"""VAD-driven transcription chunks.

Speech regions are grouped into chunks no longer than `max_chunk_s`, split only in
pauses (or, for long continuous speech, at the quietest 10 ms window), padded
without overlapping neighbours, and written as 16 kHz WAV slices. Each chunk's
start time lets word timestamps return exactly to the source timeline.
"""

from __future__ import annotations

import os

import numpy as np
import soundfile as sf

from .features import rms_envelope


def plan_chunks(regions: list[tuple[float, float]], env: np.ndarray, window_s: float, max_chunk_s: float = 28.0, merge_gap_s: float = 0.8) -> list[tuple[float, float]]:
    regions = sorted(regions)
    groups: list[list[float]] = []
    for s, e in regions:
        if groups and s - groups[-1][1] <= merge_gap_s and e - groups[-1][0] <= max_chunk_s:
            groups[-1][1] = max(groups[-1][1], e)
        else:
            groups.append([s, e])
    out: list[tuple[float, float]] = []
    for s, e in groups:
        while e - s > max_chunk_s:
            lo = s + max_chunk_s * 0.6
            hi = s + max_chunk_s
            a, b = int(lo / window_s), int(hi / window_s)
            seg = env[a:b]
            cut = (a + int(np.argmin(seg))) * window_s if seg.size else hi
            out.append((s, cut))
            s = cut
        out.append((s, e))
    return out


def write_chunks(wav: str, regions: list[list[float]], out_dir: str, max_chunk_s: float = 28.0, merge_gap_s: float = 0.8, pad_s: float = 0.25) -> dict:
    x, rate = sf.read(wav, dtype="float32")
    if x.ndim > 1:
        x = x.mean(axis=1)
    window_s = 0.01
    env = rms_envelope(x.astype(np.float64), rate, window_s * 1000)
    chunks = plan_chunks([(float(a), float(b)) for a, b in regions], env, window_s, max_chunk_s, merge_gap_s)
    os.makedirs(out_dir, exist_ok=True)
    dur = len(x) / rate
    result = []
    for i, (s, e) in enumerate(chunks):
        prev_end = chunks[i - 1][1] if i > 0 else 0.0
        next_start = chunks[i + 1][0] if i + 1 < len(chunks) else dur
        ps = max(0.0, s - min(pad_s, (s - prev_end) / 2))
        pe = min(dur, e + min(pad_s, (next_start - e) / 2))
        a, b = int(round(ps * rate)), int(round(pe * rate))
        if b - a < int(0.3 * rate):
            continue
        path = os.path.join(out_dir, f"chunk_{i + 1:04d}.wav")
        sf.write(path, x[a:b], rate, subtype="PCM_16")
        result.append({"path": path, "startSample": a, "endSample": b, "startS": a / rate, "endS": b / rate, "speechStartS": s, "speechEndS": e})
    return {"rate": rate, "chunks": result, "speechSeconds": float(sum(e - s for s, e in chunks))}
