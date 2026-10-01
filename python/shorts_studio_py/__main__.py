"""Command dispatcher: python -m shorts_studio_py <command> --in args.json --out result.json

Commands read one JSON object of arguments and write one JSON result. Errors are
written as {"ok": false, "error": ...} with a non-zero exit code so the TypeScript
CLI can surface them with context.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from typing import Any, Callable

from .io import read_json, write_json


def _audio_features(a: dict) -> dict:
    from .audio.features import analyze
    from .io import load_audio, decode_audio

    if a.get("wav"):
        x, rate = load_audio(a["wav"])
    else:
        rate = int(a.get("rate", 16000))
        x = decode_audio(a["media"], rate, 1, stream=a.get("stream"))
    res = analyze(x, rate, float(a.get("windowMs", 10.0)))
    env = res.pop("envelope")
    write_json(a["envelopeOut"], env)
    res["envelopePath"] = a["envelopeOut"]
    res["sampleRate"] = rate
    res["windowMs"] = float(a.get("windowMs", 10.0))
    return res


def _loudness(a: dict) -> dict:
    from .audio.loudness import measure
    from .io import load_audio

    out = {}
    for key, path in a["files"].items():
        x, rate = load_audio(path, mono=False)
        out[key] = {"path": path, **measure(x, rate)}
    return {"measurements": out}


def _sync(a: dict) -> dict:
    from .audio.sync import align, spot_check
    from .io import decode_audio

    rate = 16000
    cam = decode_audio(a["camera"], rate, 1, stream=a.get("cameraStream"))
    mic = decode_audio(a["mic"], rate, 1, stream=a.get("micStream"))
    res = align(cam, mic, rate, float(a.get("maxOffsetS", 60.0)), float(a.get("windowS", 12.0)), int(a.get("windows", 8)))
    dur = len(cam) / rate
    checks = [dur * f for f in (0.2, 0.5, 0.8)]
    res["spotChecks"] = spot_check(cam, mic, rate, res["offsetS"], res["driftPpm"], checks) if res["status"] != "unreliable" else []
    # A confident spot check that disagrees with the fit downgrades a confirmed sync.
    bad = [c for c in res["spotChecks"] if c.get("status") == "mismatch"]
    if bad and res["status"] == "confirmed":
        res["status"] = "probable"
        res["reason"] = f"{len(bad)} spot check(s) disagree with the fitted alignment: " + ", ".join(f"{c['t']:.1f} s {c['residualMs']:+.1f} ms" for c in bad)
    res["cameraDurationS"] = dur
    res["micDurationS"] = len(mic) / rate
    return res


def _endpoints(a: dict) -> dict:
    from .audio.endpoint import find_line_end, find_line_start, quiet_stretches
    from .io import load_audio, decode_audio

    if a.get("wav"):
        x, rate = load_audio(a["wav"])
    else:
        rate = 48000
        x = decode_audio(a["media"], rate, 1)
    lines = []
    for ln in a["lines"]:
        start = find_line_start(x, rate, ln["firstWordStartS"], ln.get("prevSoundEndS"), float(a.get("onsetDb", -40)))
        end = find_line_end(x, rate, ln["lastWordEndS"], ln.get("nextSoundStartS"), float(a.get("endDb", -35)), float(a.get("sustainDb", -32)), float(a.get("sustainMs", 150)))
        quiet = quiet_stretches(x, rate, start["startS"], end["endS"], float(a.get("quietDb", -45)), float(a.get("quietMinMs", 100)))
        lines.append({"id": ln["id"], "start": start, "end": end, "quiet": quiet})
    return {"lines": lines, "sampleRate": rate}


def _faces(a: dict) -> dict:
    from .cv.faces import track_faces

    return track_faces(
        a["video"],
        a["model"],
        int(a["width"]),
        int(a["height"]),
        float(a.get("fps", 5.0)),
        int(a.get("analysisWidth", 640)),
        float(a.get("startS", 0.0)),
        a.get("durS"),
        a.get("sceneCutsS", []),
    )


def _sheet(a: dict) -> dict:
    from .cv.sheets import contact_sheet, overview_times

    times = a.get("times")
    if times is None:
        times = overview_times(float(a["durationS"]), int(a.get("count", 12)), a.get("sceneStartsS"))
    return contact_sheet(
        a["video"],
        [float(t) for t in times],
        a["out"],
        int(a["width"]),
        int(a["height"]),
        int(a.get("tileW", 400)),
        int(a.get("cols", 4)),
        a.get("title", ""),
        a.get("labels"),
        a.get("fontPath"),
        a.get("overlays"),
    )


def _font_metrics(a: dict) -> dict:
    from .fonts import build

    return build(a["faces"])


def _assemble(a: dict) -> dict:
    from .audio.assemble import assemble

    return assemble(a["clips"], int(a["endSamples"]), int(a["rate"]), int(a["channels"]), a["out"])


def _caption_band(a: dict) -> dict:
    from .render.caption_band import build_band

    return build_band(a["framesDir"], a["runs"], int(a["frameCount"]), int(a["fpsNum"]), int(a["fpsDen"]), a["out"], int(a["width"]), int(a["height"]), int(a.get("margin", 48)))


def _chunks(a: dict) -> dict:
    from .audio.chunks import write_chunks

    return write_chunks(a["wav"], a["regions"], a["outDir"], float(a.get("maxChunkS", 28.0)), float(a.get("mergeGapS", 0.8)), float(a.get("padS", 0.25)))


COMMANDS: dict[str, Callable[[dict], Any]] = {
    "audio.chunks": _chunks,
    "audio.assemble": _assemble,
    "render.caption_band": _caption_band,
    "fonts.metrics": _font_metrics,
    "audio.features": _audio_features,
    "audio.loudness": _loudness,
    "audio.sync": _sync,
    "audio.endpoints": _endpoints,
    "cv.faces": _faces,
    "cv.sheet": _sheet,
}


def _load_extensions() -> None:
    """Feature modules named ext_*.py contribute their own COMMANDS dict (no shared edits)."""
    import importlib
    import pkgutil

    from . import __path__ as pkg_path

    for info in pkgutil.iter_modules(pkg_path):
        if info.name.startswith("ext_"):
            mod = importlib.import_module(f"{__package__}.{info.name}")
            COMMANDS.update(getattr(mod, "COMMANDS", {}))


def main(argv: list[str] | None = None) -> int:
    _load_extensions()
    parser = argparse.ArgumentParser(prog="shorts_studio_py")
    parser.add_argument("command")
    parser.add_argument("--in", dest="inp", required=True)
    parser.add_argument("--out", dest="out", required=True)
    args = parser.parse_args(argv)
    if args.command not in COMMANDS:
        write_json(args.out, {"ok": False, "error": f"unknown command {args.command}; known: {', '.join(sorted(COMMANDS))}"})
        return 2
    try:
        result = COMMANDS[args.command](read_json(args.inp))
        write_json(args.out, {"ok": True, "result": result})
        return 0
    except Exception as e:  # surfaced to the CLI with a traceback tail
        write_json(args.out, {"ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-4000:]})
        print(f"{args.command} failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
