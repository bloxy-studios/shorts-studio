"""Reproducible creator-edit fixtures (public-domain footage + synthetic audio).

Run:  .runtime/venv/bin/python tests/fixtures/make_fixtures.py [--out tests/fixtures/generated]

1. creator-sync/: real NASA talking-head footage (public domain) as the "camera"
   with degraded, offset and drifting camera audio; the original audio is the
   clean "mic". Ground truth (offset, drift) is written to truth.json.
2. creator-takes/: a scripted take session with repeated takes, a restart, setup
   chatter and a stuttered final take, voiced by macOS `say` (synthetic clean mic)
   plus a degraded, offset camera-audio track muxed onto the NASA camera footage.
   Lips do not match this synthetic voice — it exists to test take selection,
   alignment and J-cuts, not lip sync. truth.json lists the expected choices.
3. creator-luxury/: a real direct-to-camera soundbite (lips match) for the
   Luxury Tech layouts, eye-contact gating and head matte.

Requires: ffmpeg, macOS `say`, numpy/scipy/soundfile (runtime venv).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile

import numpy as np
import soundfile as sf
from scipy.signal import butter, fftconvolve, resample_poly, sosfilt

RATE = 48000
NASA = os.path.join(os.path.dirname(__file__), "downloaded", "nasa-artemis-soundbites.mp4")


def ff(*args: str) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-y", "-v", "error", *args], check=True)


def degrade(x: np.ndarray, seed: int) -> np.ndarray:
    """Camera-mic character: small-room reverb, band limit, hiss."""
    rng = np.random.default_rng(seed)
    n = int(0.25 * RATE)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / (0.045 * RATE))
    ir[0] = 6.0
    ir /= np.abs(ir).sum() / 4
    y = fftconvolve(x, ir)[: len(x)]
    y = sosfilt(butter(4, [140, 6500], btype="band", fs=RATE, output="sos"), y)
    y = y / (np.max(np.abs(y)) + 1e-9) * 0.35
    return y + rng.standard_normal(len(y)) * 0.004


def say(text: str, voice: str, rate_wpm: int, path: str) -> np.ndarray:
    aiff = path + ".aiff"
    subprocess.run(["say", "-v", voice, "-r", str(rate_wpm), "-o", aiff, text], check=True)
    ff("-i", aiff, "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s24le", path)
    os.remove(aiff)
    x, _ = sf.read(path, dtype="float64")
    return x


def make_sync(out: str, start: float = 18.0, dur: float = 75.0, offset_s: float = 1.75, drift_ppm: float = 40.0) -> None:
    os.makedirs(out, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        clean = os.path.join(tmp, "clean.wav")
        ff("-ss", f"{start}", "-t", f"{dur + 5}", "-i", NASA, "-vn", "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s24le", clean)
        x, _ = sf.read(clean, dtype="float64")
        # mic = camera + offset: the mic recording started `offset_s` earlier (pre-roll room tone).
        rng = np.random.default_rng(11)
        mic = np.concatenate([rng.standard_normal(int(offset_s * RATE)) * 0.0008, x])[: int((dur + offset_s) * RATE)]
        sf.write(os.path.join(out, "mic.wav"), mic, RATE, subtype="PCM_24")
        cam_audio = degrade(x[: int(dur * RATE)], seed=3)
        # camera clock runs fast by drift_ppm relative to the mic clock
        cam_audio = resample_poly(cam_audio, 25000, 25001) if drift_ppm == 40.0 else cam_audio
        cam_wav = os.path.join(tmp, "cam.wav")
        sf.write(cam_wav, cam_audio, RATE, subtype="PCM_24")
        ff("-ss", f"{start}", "-t", f"{dur}", "-i", NASA, "-i", cam_wav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "128k", "-shortest", os.path.join(out, "camera.mp4"))
    json.dump({"offsetS": offset_s, "driftPpm": drift_ppm, "note": "mic_time = camera_time + offset + drift*camera_time; real NASA speech (public domain) — lips match"}, open(os.path.join(out, "truth.json"), "w"), indent=2)


TAKES = [
    ("chatter", "Okay. Is this recording? Alright, here we go."),
    ("L1-take1", "Most people think the hardest part of building a product is the code."),
    ("chatter", "Hmm, let me try that again, more energy."),
    ("L1-take2", "Most people think the hardest part of building a product is the code."),
    ("L2-take1", "But the real work is deciding what not to build."),
    ("L3-restart", "Every feature you add is a"),
    ("L3-take1", "Every feature you add is a promise you have to keep forever."),
    ("L4-take1", "So start small, ship it, and listen to the people who use it."),
    ("chatter", "Wait, one more time for the last line."),
    ("L4-take2-defective", "So start small, ship it, and and listen to the the people who use it."),
]


def make_takes(out: str, offset_s: float = 2.4) -> None:
    os.makedirs(out, exist_ok=True)
    parts = []
    labels = []
    t = 0.6
    with tempfile.TemporaryDirectory() as tmp:
        for i, (label, text) in enumerate(TAKES):
            voice = "Daniel" if label != "chatter" else "Samantha"
            x = say(text, voice, 175, os.path.join(tmp, f"{i}.wav"))
            pause = 1.1 if label == "chatter" else 0.9
            parts.append(np.zeros(int(pause * RATE)))
            labels.append({"label": label, "text": text, "startS": round(t + pause, 3), "endS": round(t + pause + len(x) / RATE, 3)})
            parts.append(x * 0.5)
            t += pause + len(x) / RATE
        parts.append(np.zeros(int(1.0 * RATE)))
        mic = np.concatenate(parts)
        sf.write(os.path.join(out, "mic.wav"), mic, RATE, subtype="PCM_24")
        dur = len(mic) / RATE - offset_s
        cam_audio = degrade(mic[int(offset_s * RATE) :], seed=5)
        cam_wav = os.path.join(tmp, "cam.wav")
        sf.write(cam_wav, cam_audio, RATE, subtype="PCM_24")
        # Picture: two black-free soundbite spans of the NASA reel joined by a hard cut
        # (the reel has 1 s black gaps between soundbites every ~21 s).
        spans = [(16.2, 36.3), (37.5, 57.3)]
        trims = "".join(f"[0:v]trim={a}:{b},setpts=PTS-STARTPTS[v{i}];" for i, (a, b) in enumerate(spans))
        ff("-i", NASA, "-i", cam_wav, "-filter_complex", f"{trims}[v0][v1]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "1:a:0", "-t", f"{dur:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "128k", os.path.join(out, "camera.mp4"))
    truth = {
        "offsetS": offset_s,
        "driftPpm": 0,
        "takes": labels,
        "expected": {
            "L1": "take2 (last complete take)",
            "L2": "take1 (single take)",
            "L3": "take1 (the restart 'Every feature you add is a' is a false start)",
            "L4": "take1 — the last take has a stutter ('and and', 'the the'), so the earlier clean take is swapped in",
            "removed": ["setup chatter", "false start"],
        },
        "note": "Synthetic macOS `say` voice as clean mic; NASA footage as camera picture (lips do not match).",
    }
    json.dump(truth, open(os.path.join(out, "truth.json"), "w"), indent=2)


def make_luxury(out: str, start: float = 223.8, dur: float = 26.8, offset_s: float = 1.3) -> None:
    """Direct-to-camera presenter (astronaut Reid Wiseman, NASA, public domain) for Luxury Tech.

    One continuous soundbite shot in which the speaker addresses the lens; the original
    audio is the clean mic (started `offset_s` earlier), the camera carries a degraded copy.
    """
    os.makedirs(out, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        clean = os.path.join(tmp, "clean.wav")
        ff("-ss", f"{start}", "-t", f"{dur}", "-i", NASA, "-vn", "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s24le", clean)
        x, _ = sf.read(clean, dtype="float64")
        rng = np.random.default_rng(17)
        mic = np.concatenate([rng.standard_normal(int(offset_s * RATE)) * 0.0008, x, rng.standard_normal(int(0.6 * RATE)) * 0.0008])
        sf.write(os.path.join(out, "mic.wav"), mic, RATE, subtype="PCM_24")
        cam_wav = os.path.join(tmp, "cam.wav")
        sf.write(cam_wav, degrade(x, seed=7), RATE, subtype="PCM_24")
        ff("-ss", f"{start}", "-t", f"{dur}", "-i", NASA, "-i", cam_wav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-c:a", "aac", "-b:a", "128k", "-shortest", os.path.join(out, "camera.mp4"))
    truth = {
        "offsetS": offset_s,
        "driftPpm": 0,
        "sourceSpan": [start, start + dur],
        "note": "Real NASA soundbite (public domain): presenter looks at the lens; lips match the mic. For Luxury Tech layout/eye-contact/matte tests.",
    }
    json.dump(truth, open(os.path.join(out, "truth.json"), "w"), indent=2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "generated"))
    ap.add_argument("--only", choices=["sync", "takes", "luxury"], default=None)
    a = ap.parse_args()
    if not os.path.exists(NASA):
        raise SystemExit(f"missing {NASA}: download the NASA Artemis soundbites (see tests/fixtures/README.md)")
    if a.only in (None, "takes") and not shutil.which("say"):
        raise SystemExit("macOS `say` is required for the synthetic take fixture")
    if a.only in (None, "sync"):
        make_sync(os.path.join(a.out, "creator-sync"))
    if a.only in (None, "takes"):
        make_takes(os.path.join(a.out, "creator-takes"))
    if a.only in (None, "luxury"):
        make_luxury(os.path.join(a.out, "creator-luxury"))
    print(json.dumps({"ok": True, "out": a.out}))


if __name__ == "__main__":
    main()
