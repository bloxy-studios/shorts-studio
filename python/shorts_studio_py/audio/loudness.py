"""Loudness and peak measurement (ITU-R BS.1770 via pyloudnorm; true peak via 4x oversampling).

Integrated loudness is gated, so stems that are mostly silence (SFX, riser) can
read very differently from their audible events, and an entirely silent stem has
no finite loudness: that is reported as None with a note, never a fabricated number.
"""

from __future__ import annotations

import math

import numpy as np
import pyloudnorm as pyln
from scipy.signal import resample_poly

SILENCE_DBFS = -120.0


def _db(v: float) -> float | None:
    return 20.0 * math.log10(v) if v > 0 else None


def true_peak(samples: np.ndarray, oversample: int = 4) -> float:
    """Linear true peak using polyphase oversampling per channel (BS.1770-4 Annex 2 style)."""
    x = samples if samples.ndim == 2 else samples[:, None]
    peak = 0.0
    for ch in range(x.shape[1]):
        up = resample_poly(x[:, ch], oversample, 1)
        peak = max(peak, float(np.max(np.abs(up))) if up.size else 0.0)
    return peak


def measure(samples: np.ndarray, rate: int) -> dict:
    x = samples if samples.ndim == 2 else samples[:, None]
    sample_peak = float(np.max(np.abs(x))) if x.size else 0.0
    result: dict = {
        "durationSamples": int(x.shape[0]),
        "sampleRate": rate,
        "channels": int(x.shape[1]),
        "samplePeakDbfs": _db(sample_peak),
        "truePeakDbtp": _db(true_peak(x)),
        "integratedLufs": None,
        "note": None,
    }
    if sample_peak == 0.0:
        result["note"] = "silent: integrated loudness undefined"
        return result
    meter = pyln.Meter(rate)
    data = x if x.shape[1] > 1 else x[:, 0]
    if x.shape[0] < int(0.4 * rate):
        result["note"] = "shorter than one 400 ms gating block: integrated loudness undefined"
        return result
    lufs = float(meter.integrated_loudness(data))
    if math.isfinite(lufs):
        result["integratedLufs"] = lufs
    else:
        result["note"] = "all gating blocks below the absolute gate: integrated loudness undefined"
    active = np.abs(data if data.ndim == 1 else data.mean(axis=1)) > 10 ** (-60 / 20)
    frac = float(active.mean()) if active.size else 0.0
    if frac < 0.5 and result["integratedLufs"] is not None:
        result["note"] = f"sparse stem ({frac:.0%} of samples above -60 dBFS): gated integrated loudness reflects only its audible events"
    return result


def gain_to_target(current_lufs: float, target_lufs: float) -> float:
    return target_lufs - current_lufs
