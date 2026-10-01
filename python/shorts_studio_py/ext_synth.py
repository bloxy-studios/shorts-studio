"""Commands for code-synthesized stems (music bed, SFX events, riser) and SFX rule checks."""

from __future__ import annotations

import numpy as np
import soundfile as sf

from .audio.loudness import measure
from .audio.synth import RATE, flat_gain_to_lufs, music_bed, render_events, validate_sfx


def _stereo(x: np.ndarray) -> np.ndarray:
    return np.stack([x, x], axis=1) if x.ndim == 1 else x


def music(a: dict) -> dict:
    end = int(a["endSamples"])
    x = music_bed(end, int(a.get("fpsNum", 60)), int(a.get("fpsDen", 1)), float(a.get("bpm", 108)), str(a.get("key", "C")), int(a.get("seed", 7)), float(a.get("fadeOutMs", 800)), float(a.get("declickMs", 5)))
    target = float(a.get("targetLufs", -24)) + float(a.get("gainDb", 0))
    x, gain, before = flat_gain_to_lufs(x, target)
    if np.max(np.abs(x)) > 0.98:
        x = x * (0.98 / np.max(np.abs(x)))
    sf.write(a["out"], x, RATE, subtype="PCM_24")
    m = measure(x, RATE)
    return {"path": a["out"], "flatGainDb": round(gain, 3), "measuredBeforeLufs": before, "targetLufs": target, **m, "bpm": float(a.get("bpm", 108)), "seed": int(a.get("seed", 7)), "firstBeatSample": int(round(RATE * int(a.get("fpsDen", 1)) / int(a.get("fpsNum", 60))))}


def events(a: dict) -> dict:
    end = int(a["endSamples"])
    sfx, riser, placements = render_events(a["events"], end, float(a["voicePeakDbfs"]), int(a.get("seed", 7)))
    sf.write(a["sfxOut"], _stereo(sfx), RATE, subtype="PCM_24")
    sf.write(a["riserOut"], _stereo(riser), RATE, subtype="PCM_24")
    return {"sfx": {"path": a["sfxOut"], **measure(_stereo(sfx), RATE)}, "riser": {"path": a["riserOut"], **measure(_stereo(riser), RATE)}, "placements": placements}


def validate(a: dict) -> dict:
    return {"violations": validate_sfx(a["events"], a.get("whips", []), a.get("cutsS", []), a.get("runs", []), int(a.get("maxPerRun", 1)), int(a.get("maxTotal", 3)))}


COMMANDS = {"synth.music": music, "synth.events": events, "synth.validate": validate}
