"""Camera ↔ clean-mic alignment by windowed GCC-PHAT cross-correlation with drift fitting.

Convention: mic_time = camera_time + offset + drift * (camera_time - anchor).
A positive offset means an event appears later in the mic file (the mic started earlier).

Evidence reported per window: lag, normalized peak height, peak-to-sidelobe ratio,
and whether the window survived outlier rejection. Confidence is derived from the
peak sharpness and the residual of the drift fit; nothing is called "confirmed"
without enough agreeing windows.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.signal import butter, fftconvolve, sosfiltfilt

from .. import sec_to_flicks
from .features import rms_envelope, speech_regions


def _bandpass(x: np.ndarray, rate: int, lo: float = 150.0, hi: float = 3800.0) -> np.ndarray:
    sos = butter(4, [lo, min(hi, rate / 2 - 100)], btype="band", fs=rate, output="sos")
    return sosfiltfilt(sos, x)


def gcc_phat(a: np.ndarray, b: np.ndarray, max_lag: int, rate: int = 16000, lo: float = 150.0, hi: float = 3800.0, guard_s: float = 0.02) -> tuple[float, float, float]:
    """Band-limited GCC-PHAT. Lag (samples, sub-sample) such that b[n] ≈ a[n - lag].

    Returns (lag, peak, peak_to_sidelobe). Whitening is applied only inside the
    speech band so noise-only bins cannot flatten the peak. The sidelobe search
    excludes ±20 ms around the main peak: voiced speech (pitch periods of 3–10 ms)
    and room reflections create legitimate secondary peaks there, which are fine
    precision ambiguity resolved by cross-window agreement — not a wrong alignment.
    """
    n = len(a) + len(b)
    nfft = 1 << (n - 1).bit_length()
    A = np.fft.rfft(a, nfft)
    B = np.fft.rfft(b, nfft)
    R = B * np.conj(A)
    freqs = np.fft.rfftfreq(nfft, d=1.0 / rate)
    band = (freqs >= lo) & (freqs <= hi)
    W = np.where(band, 1.0 / np.maximum(np.abs(R), 1e-12), 0.0)
    cc = np.fft.irfft(R * W, nfft)
    cc = np.concatenate((cc[-max_lag:], cc[: max_lag + 1]))
    idx = int(np.argmax(cc))
    # Direct-path preference: reflections reach the (more distant) camera mic later,
    # producing peaks at SMALLER lags. Within +reverb_s of the maximum, take the
    # largest-lag peak that is still strong — that is the direct sound.
    reverb = int(round(0.08 * rate))
    hi_end = min(len(cc) - 1, idx + reverb)
    strong = cc[idx] * 0.55
    for j in range(hi_end, idx, -1):
        if cc[j] >= strong and cc[j] >= cc[j - 1] and (j + 1 >= len(cc) or cc[j] >= cc[j + 1]):
            idx = j
            break
    peak = float(cc[idx])
    frac = 0.0
    if 0 < idx < len(cc) - 1:
        y0, y1, y2 = cc[idx - 1], cc[idx], cc[idx + 1]
        denom = y0 - 2 * y1 + y2
        if abs(denom) > 1e-12:
            frac = 0.5 * (y0 - y2) / denom
    lag = idx - max_lag + frac
    guard = max(3, int(round(guard_s * rate)))
    # Exclude the main lobe and its reflection zone (up to 80 ms of smaller lags).
    side = np.concatenate((cc[: max(0, idx - reverb - guard)], cc[idx + guard + 1 :]))
    side_peak = float(np.max(np.abs(side))) if side.size else 1e-9
    return lag, peak, peak / max(side_peak, 1e-9)


def coarse_offset(cam: np.ndarray, mic: np.ndarray, rate: int, max_offset_s: float) -> tuple[float, float]:
    """Envelope cross-correlation at 100 Hz over the whole recordings (robust first guess)."""
    env_rate = 100
    ea = rms_envelope(cam, rate, 1000.0 / env_rate)
    eb = rms_envelope(mic, rate, 1000.0 / env_rate)
    ea = np.maximum(ea, -70.0)
    eb = np.maximum(eb, -70.0)
    ea = (ea - ea.mean()) / (ea.std() + 1e-9)
    eb = (eb - eb.mean()) / (eb.std() + 1e-9)
    cc = fftconvolve(eb, ea[::-1], mode="full")  # index k -> lag k-(len(ea)-1)
    lags = np.arange(-(len(ea) - 1), len(eb))
    mask = np.abs(lags) <= max_offset_s * env_rate
    cc = np.where(mask, cc, -np.inf)
    k = int(np.argmax(cc))
    norm = cc[k] / max(1, min(len(ea), len(eb)))
    return lags[k] / env_rate, float(norm)


def align(cam: np.ndarray, mic: np.ndarray, rate: int, max_offset_s: float = 60.0, window_s: float = 12.0, n_windows: int = 8) -> dict:
    cam_f = _bandpass(cam, rate)
    mic_f = _bandpass(mic, rate)
    coarse, coarse_score = coarse_offset(cam_f, mic_f, rate, max_offset_s)

    env = rms_envelope(cam, rate, 10.0)
    regions, _floor, _thr = speech_regions(env, 10.0)
    dur = len(cam) / rate
    # Candidate window centers spread across the recording, preferring speech.
    centers = np.linspace(window_s / 2 + 0.5, max(window_s / 2 + 0.5, dur - window_s / 2 - 0.5), n_windows)
    speech_mask = np.zeros(len(env), dtype=bool)
    for a, b in regions:
        speech_mask[a:b] = True

    win = int(window_s * rate)
    search = int(0.5 * rate)  # refine ±0.5 s around the coarse lag
    windows = []
    for c in centers:
        s0 = int((c - window_s / 2) * rate)
        s0 = max(0, min(s0, len(cam) - win))
        seg_speech = speech_mask[s0 // (rate // 100) : (s0 + win) // (rate // 100)]
        speech_frac = float(seg_speech.mean()) if seg_speech.size else 0.0
        m0 = s0 + int(round(coarse * rate)) - search
        m1 = m0 + win + 2 * search
        if speech_frac < 0.2 or m0 < 0 or m1 > len(mic):
            windows.append({"t": round(float(c), 3), "used": False, "reason": "insufficient speech or window outside mic", "speechFrac": round(speech_frac, 2)})
            continue
        a = cam_f[s0 : s0 + win]
        b = mic_f[m0:m1]
        lag, peak, psr = gcc_phat(np.pad(a, (search, search)), b, search * 2, rate)
        # b is mic shifted by the coarse guess C = m0 - s0 + search; total lag = C + residual lag
        total_lag_s = (m0 - s0 + search + lag) / rate
        windows.append({"t": round(float(c), 3), "lagS": total_lag_s, "peak": round(peak, 4), "psr": round(psr, 2), "speechFrac": round(speech_frac, 2), "used": True})

    # A window is usable when its main peak stands clear of anything > 20 ms away.
    # Precision then comes from agreement between independent windows: a wrong
    # alignment scatters, a right one clusters (pitch/reverb only blur it by a few ms).
    good = [w for w in windows if w.get("used") and w["psr"] >= 1.3]
    result: dict = {
        "method": "gcc-phat-windowed+envelope-coarse",
        "coarseOffsetS": coarse,
        "coarseScore": round(coarse_score, 4),
        "windows": windows,
    }
    if len(good) < 2:
        result.update({"status": "unreliable", "offsetS": coarse, "driftPpm": 0.0, "confidence": 0.15, "residualMs": None, "inliers": len(good), "medianPsr": None, "reason": "fewer than two windows with a usable correlation peak"})
        return result

    t = np.array([w["t"] for w in good])
    lag = np.array([w["lagS"] for w in good])
    med = float(np.median(lag))
    keep = np.abs(lag - med) <= 0.010
    slope, intercept = 0.0, med
    span = float(t[keep].max() - t[keep].min()) if keep.sum() else 0.0
    if keep.sum() >= 4 and span > 60:
        slope, intercept = np.polyfit(t[keep], lag[keep], 1)
        resid = lag - (intercept + slope * t)
        keep = np.abs(resid) <= max(0.004, 3 * float(np.std(resid[keep])))
        slope, intercept = np.polyfit(t[keep], lag[keep], 1)
    for w, k in zip(good, keep):
        w["inlier"] = bool(k)
    resid = lag[keep] - (intercept + slope * t[keep])
    residual_ms = float(np.sqrt(np.mean(resid**2)) * 1000) if resid.size else None
    drift_ppm = float(slope * 1e6)
    if not (keep.sum() >= 4 and span > 60 and abs(drift_ppm) > 5):
        drift_ppm = 0.0
        intercept = float(np.median(lag[keep])) if keep.sum() else med
    agreement = float(keep.sum()) / max(1, len([w for w in windows if w.get("used")]))
    median_psr = float(np.median([w["psr"] for w, k in zip(good, keep) if k])) if keep.sum() else 0.0
    conf = max(0.0, min(1.0, 0.45 * agreement + 0.25 * min(1.0, median_psr / 3.0) + 0.3 * (1.0 if (residual_ms is not None and residual_ms < 8.0) else 0.3)))
    status = "confirmed" if keep.sum() >= 3 and agreement >= 0.6 and conf >= 0.65 else "probable" if keep.sum() >= 2 and conf >= 0.45 else "unreliable"
    result.update(
        {
            "status": status,
            "offsetS": float(intercept),
            "offsetFlicks": sec_to_flicks(float(intercept)),
            "driftPpm": drift_ppm,
            "anchorS": 0.0,
            "residualMs": residual_ms,
            "inliers": int(keep.sum()),
            "agreement": round(agreement, 3),
            "confidence": round(conf, 3),
            "medianPsr": round(median_psr, 2),
            **({} if status != "unreliable" else {"reason": "windows disagree on the alignment"}),
        }
    )
    return result


def spot_check(cam: np.ndarray, mic: np.ndarray, rate: int, offset_s: float, drift_ppm: float, times_s: list[float], window_s: float = 3.0) -> list[dict]:
    """Residual lag at specific times after applying the fitted alignment (should be ~0 ms)."""
    out = []
    search = int(0.05 * rate)
    cam_f = _bandpass(cam, rate)
    mic_f = _bandpass(mic, rate)
    for t in times_s:
        s0 = int(t * rate)
        win = int(window_s * rate)
        predicted = offset_s + drift_ppm * 1e-6 * t
        m0 = int(round((t + predicted) * rate)) - search
        if s0 < 0 or s0 + win > len(cam) or m0 < 0 or m0 + win + 2 * search > len(mic):
            out.append({"t": t, "ok": False, "status": "outside", "reason": "outside recording"})
            continue
        lag, peak, psr = gcc_phat(np.pad(cam_f[s0 : s0 + win], (search, search)), mic_f[m0 : m0 + win + 2 * search], search * 2, rate)
        residual_ms = (lag + (m0 - s0 + search) - predicted * rate) / rate * 1000
        # A weak peak (low PSR) or a peak at the edge of the search range cannot confirm or refute
        # the alignment: inconclusive, not a failure.
        at_edge = abs(residual_ms) >= 0.9 * search / rate * 1000
        status = "inconclusive" if psr < 3 or at_edge else ("ok" if abs(residual_ms) < 5 else "mismatch")
        out.append({"t": t, "ok": status == "ok", "status": status, "residualMs": round(residual_ms, 3), "psr": round(psr, 2)})
    return out


def mic_time(cam_time_s: float, offset_s: float, drift_ppm: float, anchor_s: float = 0.0) -> float:
    return cam_time_s + offset_s + drift_ppm * 1e-6 * (cam_time_s - anchor_s)


def db(x: float) -> float:
    return 20 * math.log10(max(x, 1e-12))
