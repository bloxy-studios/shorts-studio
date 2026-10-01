"""Shared I/O: JSON args/results, WAV loading, and FFmpeg decode pipes (argument arrays only)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from typing import Any, Iterator

import numpy as np
import soundfile as sf


def ffmpeg_bin() -> str:
    return os.environ.get("SS_FFMPEG_BIN") or shutil.which("ffmpeg") or "ffmpeg"


def read_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: str, value: Any) -> None:
    """Atomic JSON write."""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def load_audio(path: str, mono: bool = True) -> tuple[np.ndarray, int]:
    """Loads a WAV/FLAC as float64 in [-1, 1]. Returns (samples, rate)."""
    data, rate = sf.read(path, dtype="float64", always_2d=True)
    if mono:
        data = data.mean(axis=1)
    return data, int(rate)


def write_wav(path: str, samples: np.ndarray, rate: int, subtype: str = "PCM_24") -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    sf.write(path, samples, rate, subtype=subtype)


def decode_audio(path: str, rate: int, channels: int = 1, start_sec: float | None = None, dur_sec: float | None = None, stream: int | None = None) -> np.ndarray:
    """Decodes audio with ffmpeg to float32, zero-padding any leading gap so sample 0 = container time 0."""
    cmd = [ffmpeg_bin(), "-v", "error", "-nostdin"]
    if start_sec is not None:
        cmd += ["-ss", f"{start_sec:.6f}"]
    if dur_sec is not None:
        cmd += ["-t", f"{dur_sec:.6f}"]
    cmd += ["-i", path]
    if stream is not None:
        cmd += ["-map", f"0:{stream}"]
    else:
        cmd += ["-map", "0:a:0"]
    cmd += ["-af", "aresample=async=1:first_pts=0", "-ac", str(channels), "-ar", str(rate), "-f", "f32le", "-"]
    out = subprocess.run(cmd, check=True, capture_output=True).stdout
    arr = np.frombuffer(out, dtype=np.float32)
    if channels > 1:
        arr = arr.reshape(-1, channels)
    return arr.astype(np.float64)


def iter_frames(path: str, fps: float, width: int, height: int, start_sec: float = 0.0, dur_sec: float | None = None) -> Iterator[tuple[float, np.ndarray]]:
    """Yields (time_sec, BGR frame) sampled at `fps` using ffmpeg's timestamp-based fps filter.

    Times are source presentation times, so VFR sources are sampled correctly.
    """
    cmd = [ffmpeg_bin(), "-v", "error", "-nostdin"]
    if start_sec > 0:
        cmd += ["-ss", f"{start_sec:.6f}"]
    if dur_sec is not None:
        cmd += ["-t", f"{dur_sec:.6f}"]
    cmd += [
        "-i",
        path,
        "-map",
        "0:v:0",
        "-vf",
        f"fps={fps}:round=near,scale={width}:{height}:flags=area,format=bgr24",
        "-f",
        "rawvideo",
        "-",
    ]
    frame_bytes = width * height * 3
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    index = 0
    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            frame = np.frombuffer(buf, dtype=np.uint8).reshape(height, width, 3)
            yield start_sec + index / fps, frame
            index += 1
    finally:
        proc.stdout.close()
        proc.wait()


def grab_frame(path: str, t_sec: float, width: int, height: int) -> np.ndarray:
    """Single accurate frame at t (input seek + decode forward), scaled to width x height.

    Callers pass upright display dimensions from the probe; ffmpeg applies rotation metadata.
    """
    cmd = [
        ffmpeg_bin(), "-v", "error", "-nostdin", "-ss", f"{max(t_sec, 0):.6f}", "-i", path,
        "-map", "0:v:0", "-frames:v", "1", "-vf", f"scale={width}:{height}:flags=area,format=bgr24",
        "-f", "rawvideo", "-",
    ]
    out = subprocess.run(cmd, check=True, capture_output=True).stdout
    expected = width * height * 3
    if len(out) < expected:
        raise RuntimeError(f"no frame decoded at {t_sec:.3f}s from {path}")
    return np.frombuffer(out[:expected], dtype=np.uint8).reshape(height, width, 3).copy()
