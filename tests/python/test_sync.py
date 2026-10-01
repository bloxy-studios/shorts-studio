"""Sync must recover a known camera↔mic offset and clock drift from speech-like audio."""

import numpy as np
from scipy.signal import resample_poly, butter, sosfilt

from shorts_studio_py.audio.sync import align, spot_check

RATE = 16000


def speechlike(seconds: float, seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    noise = rng.standard_normal(n)
    sos = butter(4, [200, 3500], btype="band", fs=RATE, output="sos")
    noise = sosfilt(sos, noise)
    env = np.zeros(n)
    t = 0.0
    while t < seconds:
        syl = rng.uniform(0.08, 0.25)
        if rng.random() < 0.15:
            t += rng.uniform(0.3, 0.9)  # pause
            continue
        a, b = int(t * RATE), int(min(seconds, t + syl) * RATE)
        env[a:b] = np.hanning(b - a) * rng.uniform(0.3, 1.0)
        t += syl + rng.uniform(0.02, 0.08)
    return noise * env * 0.3


def make_pair(offset_s: float, drift_ppm: float, seconds: float = 150.0):
    clean = speechlike(seconds + 10)
    # mic_time = cam_time + offset  =>  cam[n] = mic[n + offset]
    shift = int(round(offset_s * RATE))
    cam = clean[shift : shift + int(seconds * RATE)].copy() if shift >= 0 else np.concatenate((np.zeros(-shift), clean))[: int(seconds * RATE)]
    if drift_ppm:
        # camera clock runs slow relative to mic: resample by (1 - drift)
        up = 1_000_000
        down = int(round(up * (1 + drift_ppm * 1e-6)))
        cam = resample_poly(cam, up // 1000, down // 1000)
    rng = np.random.default_rng(3)
    sos = butter(2, 5000, btype="low", fs=RATE, output="sos")
    cam = sosfilt(sos, cam) * 0.6 + rng.standard_normal(len(cam)) * 0.004
    return cam, clean


def test_recovers_constant_offset_within_one_ms():
    cam, mic = make_pair(offset_s=2.3456, drift_ppm=0.0)
    r = align(cam, mic, RATE)
    assert r["status"] in ("confirmed", "probable"), r
    assert abs(r["offsetS"] - 2.3456) < 0.001, r["offsetS"]
    assert r["driftPpm"] == 0.0
    checks = spot_check(cam, mic, RATE, r["offsetS"], r["driftPpm"], [20.0, 70.0, 120.0])
    assert all(c["ok"] for c in checks), checks


def test_unrelated_audio_is_not_confirmed():
    cam = speechlike(60, seed=1)
    mic = speechlike(60, seed=99)
    r = align(cam, mic, RATE)
    assert r["status"] != "confirmed", r


def test_fits_clock_drift_over_a_long_recording():
    clean = speechlike(170)
    offset = 1.5
    shift = int(offset * RATE)
    cam = clean[shift : shift + 150 * RATE]
    cam = resample_poly(cam, 25000, 25001)  # camera clock 40 ppm fast: mic = offset + 1.00004 * cam
    rng = np.random.default_rng(5)
    cam = cam * 0.6 + rng.standard_normal(len(cam)) * 0.004
    r = align(cam, clean, RATE, n_windows=10)
    assert r["status"] in ("confirmed", "probable"), r
    assert abs(r["driftPpm"] - 40) < 6, r["driftPpm"]
    assert abs(r["offsetS"] - offset) < 0.002, r["offsetS"]
    checks = spot_check(cam, clean, RATE, r["offsetS"], r["driftPpm"], [15.0, 75.0, 135.0])
    assert all(abs(c["residualMs"]) < 1.0 for c in checks if c.get("residualMs") is not None), checks


def test_reverberant_camera_locks_to_the_direct_path():
    """A distant camera mic hears strong reflections; the reflection peaks must not win."""
    clean = speechlike(100)
    offset = 1.2
    cam = clean[int(offset * RATE) : int(offset * RATE) + 90 * RATE].copy()
    rng = np.random.default_rng(9)
    n = int(0.25 * RATE)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / (0.045 * RATE))
    ir[0] = 6.0  # direct path weaker than the total reverberant energy
    from scipy.signal import fftconvolve

    cam = fftconvolve(cam, ir)[: len(cam)] * 0.05 + rng.standard_normal(len(cam)) * 0.003
    r = align(cam, clean, RATE)
    assert r["status"] in ("confirmed", "probable"), r
    assert abs(r["offsetS"] - offset) < 0.003, r["offsetS"]
