"""Sample-accurate stem assembly from EditPlan audio clips.

Each clip copies [srcStart, srcStart+len) samples from a source WAV that is aligned
to its container's time zero, applies raised-cosine fades and a static gain, and
adds it at outStart. The stem is exactly `end_samples` long (END), so every stem
shares the timeline length. Overloads are reported, never silently normalized.
"""

from __future__ import annotations

import numpy as np
import soundfile as sf


def _fade(n: int) -> np.ndarray:
    if n <= 0:
        return np.ones(0)
    return 0.5 - 0.5 * np.cos(np.pi * (np.arange(n) + 0.5) / n)


def assemble(clips: list[dict], end_samples: int, rate: int, channels: int, out_path: str) -> dict:
    buf = np.zeros((end_samples, channels), dtype=np.float64)
    placed = []
    for c in clips:
        src = c["sourcePath"]
        info = sf.info(src)
        if info.samplerate != rate:
            raise ValueError(f"{src} is {info.samplerate} Hz, expected {rate}")
        start = int(c["srcStartSamples"])
        length = int(c["lengthSamples"])
        out = int(c["outStartSamples"])
        if out < 0 or out + length > end_samples:
            raise ValueError(f"clip {c.get('id')} [{out}, {out + length}) falls outside [0, {end_samples})")
        avail = max(0, min(length, info.frames - start))
        data = np.zeros((length, channels))
        if avail > 0 and start >= 0:
            raw, _ = sf.read(src, start=start, stop=start + avail, dtype="float64", always_2d=True)
            if raw.shape[1] == channels:
                data[:avail] = raw
            elif raw.shape[1] == 1:
                data[:avail] = np.repeat(raw, channels, axis=1)
            else:
                mono = raw.mean(axis=1, keepdims=True)
                data[:avail] = np.repeat(mono, channels, axis=1)
        fin = min(int(c.get("fadeInSamples", 0)), length)
        fout = min(int(c.get("fadeOutSamples", 0)), length)
        if fin:
            data[:fin] *= _fade(fin)[:, None]
        if fout:
            data[length - fout :] *= _fade(fout)[::-1][:, None]
        gain = 10 ** (float(c.get("gainDb", 0.0)) / 20.0)
        buf[out : out + length] += data * gain
        placed.append({"id": c.get("id"), "outStart": out, "length": length, "missingSamples": length - avail})
    peak = float(np.max(np.abs(buf))) if buf.size else 0.0
    sf.write(out_path, buf, rate, subtype="PCM_24")
    return {
        "path": out_path,
        "samples": end_samples,
        "rate": rate,
        "channels": channels,
        "peak": peak,
        "overload": peak > 1.0,
        "clips": placed,
    }
