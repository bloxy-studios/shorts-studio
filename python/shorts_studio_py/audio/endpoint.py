"""Measured speech boundaries for creator-edit cuts.

Uses 10 ms RMS windows on the clean voice track. Thresholds are measurements with
an explicit reference (dBFS, full scale = 1.0 amplitude), not guarantees of where
language ends, so each boundary also checks for quiet trailing consonants and
breaths and records any deviation needed to keep a word intelligible.
"""

from __future__ import annotations

import numpy as np

from .. import sec_to_flicks
from .features import rms_envelope

WINDOW_MS = 10.0


def _energy_hf(x: np.ndarray, rate: int, window_ms: float = WINDOW_MS) -> np.ndarray:
    """High-frequency (> 3 kHz) RMS per window — sensitive to quiet fricatives like s/f/th."""
    from scipy.signal import butter, sosfilt

    sos = butter(4, 3000.0, btype="high", fs=rate, output="sos")
    return rms_envelope(sosfilt(sos, x), rate, window_ms)


def find_line_end(x: np.ndarray, rate: int, word_end_s: float, next_sound_s: float | None, end_db: float = -35.0, sustain_db: float = -32.0, sustain_ms: float = 150.0, max_extend_ms: float = 400.0) -> dict:
    """True audible end of a line after the transcript's last word end.

    Rule (reference preset): first 10 ms window at/after the word end where level
    drops below `end_db`, provided the following `sustain_ms` stays below
    `sustain_db`. A trailing fricative (HF energy well above the floor) extends the
    end. The end never passes `next_sound_s`.
    """
    env = rms_envelope(x, rate, WINDOW_MS)
    hf = _energy_hf(x, rate, WINDOW_MS)
    w = WINDOW_MS / 1000.0
    start = max(0, int(word_end_s / w) - 5)
    limit = int(min(len(env), (word_end_s + max_extend_ms / 1000.0) / w))
    if next_sound_s is not None:
        limit = min(limit, int(next_sound_s / w))
    sustain = int(round(sustain_ms / WINDOW_MS))
    hf_floor = float(np.percentile(hf, 10)) if hf.size else -100.0
    deviation = None
    end_idx = None
    for i in range(start, max(start + 1, limit)):
        if env[i] < end_db and np.all(env[i : i + sustain] < sustain_db):
            if hf[i] > hf_floor + 15 and i + 3 < limit:
                deviation = "extended past RMS cue: high-frequency energy suggests a quiet trailing consonant"
                continue
            end_idx = i
            break
    if end_idx is None:
        end_idx = limit
        deviation = deviation or "no sustained quiet region before the limit; used the limit"
    return {
        "endS": end_idx * w,
        "endFlicks": sec_to_flicks(end_idx * w),
        "wordEndS": word_end_s,
        "levelAtEndDb": float(env[min(end_idx, len(env) - 1)]),
        "deviation": deviation,
        "rule": {"endDb": end_db, "sustainDb": sustain_db, "sustainMs": sustain_ms, "windowMs": WINDOW_MS, "reference": "dBFS RMS, full scale = 1.0"},
    }


def find_line_start(x: np.ndarray, rate: int, word_start_s: float, prev_sound_end_s: float | None, onset_db: float = -40.0, max_back_ms: float = 200.0) -> dict:
    """Audible onset at or slightly before the first word (catches soft consonant/breath onsets)."""
    env = rms_envelope(x, rate, WINDOW_MS)
    w = WINDOW_MS / 1000.0
    i = int(word_start_s / w)
    lo = int(max(0.0, word_start_s - max_back_ms / 1000.0) / w)
    if prev_sound_end_s is not None:
        lo = max(lo, int(prev_sound_end_s / w))
    while i > lo and env[i - 1] >= onset_db:
        i -= 1
    return {"startS": i * w, "startFlicks": sec_to_flicks(i * w), "wordStartS": word_start_s, "levelDb": float(env[min(i, len(env) - 1)])}


def quiet_stretches(x: np.ndarray, rate: int, t0: float, t1: float, below_db: float = -45.0, min_ms: float = 100.0) -> list[dict]:
    """Quiet runs inside [t0, t1) — used to compress pauses and to QA joins."""
    env = rms_envelope(x, rate, WINDOW_MS)
    w = WINDOW_MS / 1000.0
    a, b = int(t0 / w), int(min(len(env), t1 / w))
    out = []
    i = a
    while i < b:
        if env[i] < below_db:
            j = i
            while j < b and env[j] < below_db:
                j += 1
            if (j - i) * WINDOW_MS >= min_ms:
                out.append({"startS": i * w, "endS": j * w, "ms": (j - i) * WINDOW_MS})
            i = j
        else:
            i += 1
    return out
