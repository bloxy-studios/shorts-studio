"""Synthesized stems: deterministic, exact length, measured levels, correct anchors, rules enforced."""

import numpy as np
import pyloudnorm as pyln

from shorts_studio_py.audio.synth import RATE, flat_gain_to_lufs, music_bed, render_events, validate_sfx


def test_music_is_deterministic_exact_length_and_hits_target_loudness():
    end = 12 * RATE
    a = music_bed(end, 60, 1, bpm=110, key="C", seed=3)
    b = music_bed(end, 60, 1, bpm=110, key="C", seed=3)
    assert a.shape == (end, 2)
    assert np.array_equal(a, b)
    x, gain, _ = flat_gain_to_lufs(a, -24.0)
    lufs = pyln.Meter(RATE).integrated_loudness(x)
    assert abs(lufs - (-24.0)) < 0.5


def test_first_beat_at_frame_one_with_declick_and_fade_to_end():
    end = 8 * RATE
    x = music_bed(end, 60, 1, bpm=100, seed=1)
    first_frame = RATE // 60  # 800 samples
    assert np.max(np.abs(x[:first_frame])) == 0.0
    onset = np.argmax(np.abs(x[:, 0]) > 1e-4)
    assert first_frame <= onset <= first_frame + int(0.004 * RATE)
    assert np.max(np.abs(x[-10:])) < 1e-3  # faded out exactly at END
    assert np.max(np.abs(x[first_frame : first_frame + 5])) < np.max(np.abs(x[first_frame + 400 : first_frame + 2000]))


def test_event_peaks_and_anchors():
    end = 6 * RATE
    events = [
        {"id": "c", "tSamples": 1 * RATE, "kind": "click", "variant": 0, "relPeakDb": -10},
        {"id": "w", "tSamples": 3 * RATE, "kind": "whoosh", "variant": 1, "relPeakDb": -9},
        {"id": "r", "tSamples": int(2.5 * RATE), "kind": "riser", "variant": 0, "relPeakDb": -14, "durationS": 2.4},
    ]
    sfx, riser, pl = render_events(events, end, voice_peak_dbfs=-1.0, seed=2)
    assert len(sfx) == end and len(riser) == end
    by = {p["id"]: p for p in pl}
    assert abs(by["w"]["peakSample"] - 3 * RATE) <= int(0.002 * RATE)  # whoosh loudest at the whip midpoint
    assert abs(by["c"]["startSample"] - RATE) <= 1  # click onset at its anchor
    for p in pl:
        assert abs(p["peakDbfs"] - p["requestedPeakDbfs"]) < 0.5
    assert np.max(np.abs(riser[int(2.5 * RATE) + 10 :])) < 1e-6  # riser ends at the join


def test_sfx_rules_catch_violations():
    events = [
        {"id": "w1", "tS": 2.0, "kind": "whoosh", "variant": 1, "linkedEventId": "whip1"},
        {"id": "w2", "tS": 2.5, "kind": "whoosh", "variant": 1, "linkedEventId": "whip2"},
        {"id": "w3", "tS": 6.0, "kind": "whoosh", "variant": 2},
        {"id": "p1", "tS": 4.0, "kind": "pop", "variant": 0},
    ]
    whips = [{"id": "whip1", "midpointS": 2.0}, {"id": "whip2", "midpointS": 2.6}]
    rules = {v["rule"] for v in validate_sfx(events, whips, cuts_s=[4.01], runs=[{"id": "r1", "startS": 0, "endS": 5}])}
    assert {"whoosh-needs-whip", "whoosh-at-midpoint", "whoosh-max-per-run", "whoosh-variant-repeat", "no-sfx-on-cuts"} <= rules
