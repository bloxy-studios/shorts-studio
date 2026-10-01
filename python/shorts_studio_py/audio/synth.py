"""Code-synthesized music bed, SFX vocabulary and riser (NumPy/SciPy, offline, deterministic).

Everything is original synthesis — no samples or stock audio. All stems are exactly
END samples at 48 kHz stereo so they stay aligned and remixable.

Anchors: click/tick/pop/chime are placed at their ONSET; a whoosh at its LOUDEST
point (the graphics whip midpoint); the riser at the END of its swell (the
hook → first-point join).
"""

from __future__ import annotations

import math

import numpy as np
from scipy.signal import butter, sosfilt, sosfiltfilt

RATE = 48000

NOTE = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def midi_hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def _env(n: int, attack: float, release: float, rate: int = RATE) -> np.ndarray:
    a = max(1, int(attack * rate))
    r = max(1, int(release * rate))
    e = np.ones(n)
    e[:a] = np.linspace(0, 1, a, endpoint=False) if a < n else np.linspace(0, 1, n)
    if r < n:
        e[-r:] *= np.linspace(1, 0, r)
    return e


def _lp(x: np.ndarray, hz: float, order: int = 2) -> np.ndarray:
    return sosfilt(butter(order, min(hz, RATE / 2 - 100), btype="low", fs=RATE, output="sos"), x)


def _bp(x: np.ndarray, lo: float, hi: float, order: int = 2) -> np.ndarray:
    return sosfilt(butter(order, [lo, min(hi, RATE / 2 - 100)], btype="band", fs=RATE, output="sos"), x)


def _saw(f: float, n: int, phase: float = 0.0) -> np.ndarray:
    t = np.arange(n) / RATE
    # band-limited-ish saw: sum of a few harmonics (warm, no aliasing hiss)
    out = np.zeros(n)
    for k in range(1, 9):
        if f * k > 9000:
            break
        out += ((-1) ** (k + 1)) * np.sin(2 * np.pi * f * k * t + phase * k) / k
    return out * (2 / np.pi)


# ---------------------------------------------------------------- music bed


def music_bed(end_samples: int, fps_num: int, fps_den: int, bpm: float = 108.0, key: str = "C", seed: int = 7, fade_out_ms: float = 800.0, declick_ms: float = 5.0) -> np.ndarray:
    """Warm minimal electronic bed: soft kick, ticks, rim, pad chords, restrained bass. No lead melody, no vocals."""
    rng = np.random.default_rng(seed)
    out = np.zeros((end_samples, 2))
    start = int(round(RATE * fps_den / fps_num))  # first beat at output frame one
    beat = 60.0 / bpm
    root = 48 + NOTE.get(key.upper().rstrip("M"), 0)  # C3-ish
    # I – V – vi – IV (warm, unresolved loop); 7ths for softness
    progression = [(0, [0, 4, 7, 11]), (7, [0, 4, 7, 10]), (9, [0, 3, 7, 10]), (5, [0, 4, 7, 11])]
    bar = 4 * beat
    t_end = end_samples / RATE
    n_bars = int(math.ceil((t_end - start / RATE) / bar)) + 1
    for b in range(n_bars):
        bar_t = start / RATE + b * bar
        if bar_t >= t_end:
            break
        deg, chord = progression[b % len(progression)]
        # pad: detuned saw pairs, slow attack, lowpassed, panned
        n = min(int(bar * RATE) + int(0.4 * RATE), end_samples - int(bar_t * RATE))
        if n <= 0:
            continue
        pad = np.zeros((n, 2))
        for i, iv in enumerate(chord):
            f = midi_hz(root + 12 + deg + iv)
            for det, ch in ((-0.004, 0), (0.004, 1)):
                pad[:, ch] += _saw(f * (1 + det), n, phase=rng.uniform(0, 2 * np.pi)) * (0.9 if i else 1.0)
        pad = np.stack([_lp(pad[:, 0], 1100), _lp(pad[:, 1], 1100)], axis=1) * _env(n, 0.25, 0.45)[:, None] * 0.05
        s = int(bar_t * RATE)
        out[s : s + n] += pad
        # bass: root on beats 1 and 3
        for bt in (0, 2):
            bs = int((bar_t + bt * beat) * RATE)
            if bs >= end_samples:
                continue
            bn = min(int(beat * 1.6 * RATE), end_samples - bs)
            f = midi_hz(root - 12 + deg)
            t = np.arange(bn) / RATE
            bass = np.tanh(1.6 * np.sin(2 * np.pi * f * t)) * _env(bn, 0.01, 0.25) * np.exp(-t * 1.2) * 0.12
            out[bs : bs + bn] += _lp(bass, 220)[:, None]
        # drums
        for bt in range(4):
            ts = int((bar_t + bt * beat) * RATE)
            if ts >= end_samples:
                continue
            if bt in (0, 2):  # soft kick
                kn = min(int(0.22 * RATE), end_samples - ts)
                t = np.arange(kn) / RATE
                freq = 50 + 70 * np.exp(-t * 28)
                kick = np.sin(2 * np.pi * np.cumsum(freq) / RATE) * np.exp(-t * 16) * 0.32
                out[ts : ts + kn] += kick[:, None]
            if bt in (1, 3):  # rim/clap: filtered noise
                rn = min(int(0.09 * RATE), end_samples - ts)
                rim = _bp(rng.standard_normal(rn), 1200, 4200) * np.exp(-np.arange(rn) / RATE * 45) * 0.05
                out[ts : ts + rn, 0] += rim * 0.9
                out[ts : ts + rn, 1] += rim
            for half in (0, 0.5):  # ticks on 8ths
                hs = int((bar_t + (bt + half) * beat) * RATE)
                if hs >= end_samples:
                    continue
                hn = min(int(0.03 * RATE), end_samples - hs)
                hat = sosfilt(butter(2, 7000, btype="high", fs=RATE, output="sos"), rng.standard_normal(hn)) * np.exp(-np.arange(hn) / RATE * 140) * (0.03 if half else 0.022)
                out[hs : hs + hn, 1 if half else 0] += hat
    out[:start] = 0.0
    dc = max(1, int(declick_ms / 1000 * RATE))
    out[start : start + dc] *= np.linspace(0, 1, dc)[:, None]
    fade = int(min(fade_out_ms / 1000, 0.1 * end_samples / RATE) * RATE)
    if fade > 0:
        out[end_samples - fade :] *= (np.cos(np.linspace(0, np.pi / 2, fade)) ** 2)[:, None]
    out[-1] = 0.0
    return out


# ---------------------------------------------------------------- SFX vocabulary


def sfx_click(variant: int, rng: np.random.Generator) -> tuple[np.ndarray, int]:
    n = int(0.06 * RATE)
    t = np.arange(n) / RATE
    f0 = [1900, 1650, 2100, 1800][variant % 4]
    freq = f0 * (1 - 0.35 * (1 - np.exp(-t * 90)))
    x = np.sin(2 * np.pi * np.cumsum(freq) / RATE) * np.exp(-t * 85)
    x += _bp(rng.standard_normal(n), 2500, 7000) * np.exp(-t * 400) * 0.15
    return x, 0


def sfx_tick(variant: int, rng: np.random.Generator) -> tuple[np.ndarray, int]:
    n = int(0.018 * RATE)
    lo, hi = [(2400, 5200), (2000, 4600), (2800, 6000)][variant % 3]
    x = _bp(rng.standard_normal(n), lo, hi, 3) * np.exp(-np.arange(n) / RATE * 320)
    return x, 0


def sfx_pop(variant: int, rng: np.random.Generator) -> tuple[np.ndarray, int]:
    n = int(0.2 * RATE)
    t = np.arange(n) / RATE
    f0 = [170, 150, 190][variant % 3]
    freq = f0 * (0.55 + 0.45 * np.exp(-t * 35))
    x = np.sin(2 * np.pi * np.cumsum(freq) / RATE) * np.exp(-t * 22)
    x += _lp(rng.standard_normal(n), 420) * np.exp(-t * 60) * 0.35
    return x * _env(n, 0.002, 0.02), 0


def sfx_chime(variant: int, rng: np.random.Generator) -> tuple[np.ndarray, int]:
    n = int(0.9 * RATE)
    t = np.arange(n) / RATE
    base = [76, 74, 79][variant % 3]  # E5 / D5 / G5
    notes = [(0.0, midi_hz(base)), (0.09, midi_hz(base + 7))]
    x = np.zeros(n)
    for start, f in notes:
        s = int(start * RATE)
        tt = t[: n - s]
        tone = np.sin(2 * np.pi * f * tt) + 0.35 * np.sin(2 * np.pi * f * 2.0 * tt) * np.exp(-tt * 9) + 0.15 * np.sin(2 * np.pi * f * 3.01 * tt) * np.exp(-tt * 14)
        x[s:] += tone * np.exp(-tt * 5.5) * _env(n - s, 0.004, 0.05)
    return x, 0


def sfx_whoosh(variant: int, rng: np.random.Generator, depart_s: float = 0.45, arrive_s: float = 0.6) -> tuple[np.ndarray, int]:
    """Low airy filtered-noise whoosh; returns (signal, index of the loudest point)."""
    n = int((depart_s + arrive_s) * RATE)
    peak_i = int(depart_s * RATE)
    noise = rng.standard_normal(n)
    lo, hi = [(180, 900), (140, 750), (220, 1100), (160, 820)][variant % 4]
    # sweep the band with time: rise into the peak, fall after
    chunks = 24
    out = np.zeros(n)
    for c in range(chunks):
        a, b = c * n // chunks, (c + 1) * n // chunks
        pos = (a + b) / 2 / n
        k = 1 - abs(pos - depart_s / (depart_s + arrive_s)) * 1.6
        seg = _bp(noise[max(0, a - 400) : b], lo * (0.7 + 0.6 * k), hi * (0.6 + 0.8 * k), 2)[-(b - a) :]
        out[a:b] = seg
    env = np.concatenate([np.linspace(0, 1, peak_i) ** 2.2, np.linspace(1, 0, n - peak_i) ** 1.6])
    x = out * env
    return x, int(np.argmax(np.abs(x)))


def sfx_riser(dur_s: float, rng: np.random.Generator) -> tuple[np.ndarray, int]:
    """2–3 s low swelling riser; its audible end is the anchor (returns end index)."""
    n = int(dur_s * RATE)
    t = np.arange(n) / RATE
    swell = (t / dur_s) ** 2.4
    noise = _bp(rng.standard_normal(n), 120, 2400, 2) * (0.4 + 0.6 * swell)
    f = 55 + 70 * (t / dur_s) ** 1.5
    tone = np.sin(2 * np.pi * np.cumsum(f) / RATE) * 0.6
    x = (noise * 0.6 + tone) * swell
    tail = int(0.05 * RATE)
    x[-tail:] *= np.linspace(1, 0, tail)
    return x, n - 1


GENERATORS = {"click": sfx_click, "tick": sfx_tick, "pop": sfx_pop, "chime": sfx_chime}


def render_events(events: list[dict], end_samples: int, voice_peak_dbfs: float, seed: int = 7) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """Places events into (sfx, riser) stems. Each event's sample peak = voice peak + relPeakDb."""
    sfx = np.zeros(end_samples)
    riser = np.zeros(end_samples)
    placements = []
    for e in sorted(events, key=lambda x: x["tSamples"]):
        rng = np.random.default_rng(seed * 1009 + int(e.get("variant", 0)) * 31 + int(e["tSamples"]) % 9973)
        kind = e["kind"]
        if kind == "whoosh":
            x, anchor_i = sfx_whoosh(int(e.get("variant", 0)), rng)
            anchor_i = int(np.argmax(np.abs(x)))
        elif kind == "riser":
            x, anchor_i = sfx_riser(float(e.get("durationS", 2.5)), rng)
        else:
            x, anchor_i = GENERATORS[kind](int(e.get("variant", 0)), rng)
        target = 10 ** ((voice_peak_dbfs + float(e["relPeakDb"])) / 20)
        x = x / (np.max(np.abs(x)) + 1e-12) * target
        start = int(e["tSamples"]) - anchor_i
        a, b = max(0, start), min(end_samples, start + len(x))
        seg = x[a - start : b - start].copy()
        truncated = b - start < len(x)
        if truncated and len(seg) > 64:
            seg[-64:] *= np.linspace(1, 0, 64)
        buf = riser if kind == "riser" else sfx
        buf[a:b] += seg
        peak_i = a + int(np.argmax(np.abs(seg))) if len(seg) else a
        placements.append({
            "id": e.get("id"), "kind": kind, "variant": int(e.get("variant", 0)),
            "anchorSample": int(e["tSamples"]), "startSample": int(start), "peakSample": int(peak_i),
            "peakDbfs": round(20 * math.log10(max(np.max(np.abs(seg)) if len(seg) else 1e-12, 1e-12)), 2),
            "requestedPeakDbfs": round(voice_peak_dbfs + float(e["relPeakDb"]), 2),
            "truncatedAtEnd": bool(truncated),
        })
    return sfx, riser, placements


def flat_gain_to_lufs(x: np.ndarray, target: float) -> tuple[np.ndarray, float, float | None]:
    import pyloudnorm as pyln

    meter = pyln.Meter(RATE)
    data = x if x.ndim == 1 else x
    cur = float(meter.integrated_loudness(data))
    if not math.isfinite(cur):
        return x, 0.0, None
    gain = target - cur
    return x * 10 ** (gain / 20), gain, cur


def validate_sfx(events: list[dict], whips: list[dict], cuts_s: list[float], runs: list[dict], max_per_run: int = 1, max_total: int = 3, tol_ms: float = 10.0) -> list[dict]:
    """Luxury Tech SFX rules. events: {id,tS,kind,variant,linkedEventId?}; whips: {id,midpointS}; runs: {id,startS,endS}."""
    v = []
    whoosh = [e for e in events if e["kind"] == "whoosh"]
    for e in whoosh:
        w = next((w for w in whips if w["id"] == e.get("linkedEventId")), None)
        if not w:
            v.append({"id": e["id"], "rule": "whoosh-needs-whip", "detail": "whoosh without a linked graphics whip"})
        elif abs(w["midpointS"] - e["tS"]) * 1000 > tol_ms:
            v.append({"id": e["id"], "rule": "whoosh-at-midpoint", "detail": f"peak {abs(w['midpointS'] - e['tS']) * 1000:.1f} ms from the whip midpoint"})
    if len(whoosh) > max_total:
        v.append({"id": ",".join(e["id"] for e in whoosh), "rule": "whoosh-max-total", "detail": f"{len(whoosh)} whooshes (max {max_total})"})
    for r in runs:
        inside = [e for e in whoosh if r["startS"] <= e["tS"] < r["endS"]]
        if len(inside) > max_per_run:
            v.append({"id": r["id"], "rule": "whoosh-max-per-run", "detail": f"{len(inside)} whooshes in one run"})
    ordered = sorted(whoosh, key=lambda e: e["tS"])
    for a, b in zip(ordered, ordered[1:]):
        if a.get("variant") == b.get("variant"):
            v.append({"id": b["id"], "rule": "whoosh-variant-repeat", "detail": f"same variant {b.get('variant')} as the previous whoosh"})
    for e in events:
        if e["kind"] == "riser":
            continue
        if not e.get("linkedEventId") and any(abs(e["tS"] - c) * 1000 <= 30 for c in cuts_s):
            v.append({"id": e["id"], "rule": "no-sfx-on-cuts", "detail": "unlinked sound on a layout cut"})
    return v
