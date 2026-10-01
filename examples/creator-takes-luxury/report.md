# creator-edit · render r001 · plan v3

**QA verdict:** PASS WITH WARNINGS — no hard failures; see findings. 17 passed, 2 warning(s), 0 hard failure(s). Visual review of the frame sheets is recorded below.

## Deliverables
- video: `projects/creator-takes/clips/creator-edit/renders/r001/creator-takes_creator-edit_v3_r001.mp4`
- preview: `projects/creator-takes/clips/creator-edit/renders/r001/preview_540x960.mp4`
- cover: `projects/creator-takes/clips/creator-edit/renders/r001/cover.jpg`
- master: `projects/creator-takes/clips/creator-edit/renders/r001/master.wav`
- plan: `projects/creator-takes/clips/creator-edit/renders/r001/editplan.json`
- srt: `projects/creator-takes/clips/creator-edit/renders/r001/captions.srt`
- vtt: `projects/creator-takes/clips/creator-edit/renders/r001/captions.vtt`
- wordsJson: `projects/creator-takes/clips/creator-edit/renders/r001/captions.words.json`
- stem_voice: `projects/creator-takes/clips/creator-edit/renders/r001/stems/voice.wav`
- stem_music: `projects/creator-takes/clips/creator-edit/renders/r001/stems/music.wav`
- stem_sfx: `projects/creator-takes/clips/creator-edit/renders/r001/stems/sfx.wav`
- stem_riser: `projects/creator-takes/clips/creator-edit/renders/r001/stems/riser.wav`
- qa: `projects/creator-takes/clips/creator-edit/renders/r001/qa.json`
- report: `projects/creator-takes/clips/creator-edit/renders/r001/report.md`

## Source
- src-59725a6d: camera.mp4
  39.10 s, 1280x720 @ 30 fps, bt709; acquisition local
- src-b57a30f7: mic.wav
  41.50 s; acquisition local
- Analysis coverage: transcript none, visual cv-only, audio full; 196 frames sampled.
  - limitation: no transcript yet — run transcribe
  - limitation: visual evidence is sampled (5 fps faces, 12 sheet frames)
  - limitation: no agent inspection recorded yet: reactions/visual jokes are unverified (cv-only)

## Timing
- Output: 1080x1920 @ 60 fps, 48000 Hz.
- Exact final voice sample: 13900.0 ms; frame-aligned END: 13900.0 ms = 834 frames.

| segment | output | source | words |
| --- | --- | --- | --- |
| seg001 | 00:00.000–00:03.933 | src-59725a6d 00:11.230–00:15.163 | 12 |
| seg002 | 00:03.933–00:06.767 | src-59725a6d 00:15.750–00:18.583 | 9 |
| seg003 | 00:06.767–00:09.900 | src-59725a6d 00:21.590–00:24.723 | 12 |
| seg004 | 00:09.900–00:13.900 | src-59725a6d 00:25.460–00:29.460 | 12 |

## Layout runs
| run | output | frames | layout | caption zone | reason |
| --- | --- | --- | --- | --- | --- |
| run001 | 00:00.000–00:03.933 | 236 | lt-full-visual | y 1267–1536 | hook: hook sentence → split; camera withheld: looks away (0% at lens over 19 samples) → full visual (exceptions: L1: hook sentence → split overridden — looks away (0% at lens over 19 samples)) |
| run002 | 00:03.933–00:09.900 | 358 | lt-full-visual | y 1267–1536 | body: point → full visual (alternating); point → split (alternating); camera withheld: looks away (0% at lens over 16 samples) → full visual (exceptions: L3: point → split (alternating) overridden — looks away (0% at lens over 16 samples)) |
| run003 | 00:09.900–00:13.900 | 240 | lt-full-visual | y 1267–1536 | outro: outro → full camera; camera withheld: looks away (0% at lens over 20 samples) → full visual (exceptions: L4: outro → full camera overridden — looks away (0% at lens over 20 samples)) |

## Framing
- lt-fullcam (main): static crop x=303 y=0 405x720; confidence 0.90; Luxury full camera: one stable cover-fit crop decided at setup (no pan/zoom/punch-in)
- lt-card (card): static crop x=140 y=88 731x488; confidence 0.90; split camera card: source × 1.4766 at (-207, 1070)
- lt-head (head): static crop x=140 y=14 731x102; confidence 0.85; head matte band: same frame and transform as the card

## Captions
- Style luxury-tech v1.0.0; 18 chunks; first caption at 33.3 ms; retimed from the EditPlan time map (not raw transcript times).
- Rendered as 18 HyperFrames state frame(s) and composited frame-exactly into a band at y=1306–1510.
- Emphasized words: building, deciding, feature, forever..
- Uncertain words shown as transcribed (review): none.
- Exports: SRT/VTT contain spoken words only; authored titles are never exported as speech.

## Audio
- Policy: voice-only; voice chain {"highpassHz":80,"denoise":"light","deess":true,"compress":true,"targetLufs":-14}; music synth; 49 SFX event(s).
| stem | samples | integrated | sample peak | true peak | note |
| --- | --- | --- | --- | --- | --- |
| voice | 667200 | -14.04 LUFS | -1.90 dBFS | -1.89 dBTP |  |
| music | 667200 | -24.00 LUFS | -9.31 dBFS | -9.30 dBTP |  |
| sfx | 667200 | -27.60 LUFS | -10.90 dBFS | -10.89 dBTP | sparse stem (18% of samples above -60 dBFS): gated integrated loudness reflects only its audible events |
| riser | 667200 | -27.29 LUFS | -15.90 dBFS | -15.89 dBTP | sparse stem (17% of samples above -60 dBFS): gated integrated loudness reflects only its audible events |
| master | 667200 | -13.64 LUFS | -1.90 dBFS | -1.89 dBTP |  |

## QA findings
- [PASS] export.spec (hard): H.264 1080x1920 yuv420p @ 60 fps, 834 frames, AAC 48000 Hz 2 ch
- [PASS] export.decode (hard): entire file decodes without errors
- [PASS] audio.loudness (soft): delivered integrated loudness -13.60 LUFS (target -14 ±1.0 after AAC; master WAV -13.64 LUFS)
- [PASS] audio.true-peak (hard): delivered true peak -1.60 dBTP (ceiling -1 dBTP)
- [PASS] audio.stem-length (hard): 4 stem(s) all exactly 667200 samples (END)
- [WARN] captions.sync (hard): 17/18 caption chunks overlap measured speech in the final mix; median onset lag 0 ms → repair: rebuild captions from the time map; check for dropped words at cuts
- [PASS] captions.safe-area (soft): all rendered caption bounds stay inside the generic-9x16 guide margins (approximate guides)
- [PASS] captions.face-collision (soft): no rendered caption overlaps a detected face (5 fps face samples)
- [PASS] video.black-frozen (soft): no black or frozen stretches detected
- [WARN] luxury.layouts (soft): 0 split / 3 full visual / 0 full camera; hook=full-visual, outro=full-visual; consecutive repeats at run002, run003; layouts unused: lt-split, lt-full-camera (exceptions: L1: hook sentence → split overridden — looks away (0% at lens over 19 samples); L3: point → split (alternating) overridden — looks away (0% at lens over 16 samples); L4: outro → full camera overridden — looks away (0% at lens over 20 samples))
- [PASS] luxury.static-footage (hard): 0 camera crop(s), each a single held transform (no pan/zoom/punch-in on footage)
- [PASS] luxury.landing-sharp (hard): every run lands sharp (σ=0 on frame 0 and at rest); blur on 64 moving frame(s), peak σ 17.7 px ≤ 40
- [PASS] luxury.caption-zones (soft): all 18 caption states sit inside their run's zone (split 941–1114, full camera/visual 1267–1536)
- [PASS] luxury.highlights (hard): 4 highlighted chunk(s) of 18: building, deciding, feature, forever.; Instrument Serif italic #FFFF00; first caption at frame 2
- [PASS] luxury.sfx-rules (hard): 49 SFX tied to visible graphics events (tick, whoosh, pop, click, chime); 1 whip(s) with whoosh at the midpoint; none on layout cuts; riser ends at the hook join 3.933 s
- [NOT-RUN] luxury.matte (hard): no split run with a head break-out
- [PASS] luxury.ground (soft): ground at 4 empty points of frame 118 (run001) within 3.0/255 of the radial #FFFFFF→#F3F3F0 token
- [PASS] luxury.cover-frame (soft): frame 0 carries the cover title box (centre 255,255,255); frame 1 differs by 7/255 there — "The hard part isn't the code"
- [PASS] luxury.frame-rate (info): delivered at 60 fps; camera footage is 30.00 fps, so footage frames are repeated (no added motion detail); graphics are rendered at a genuine 60 fps
- [PASS] timing.end (hard): voice ends at 13900.0 ms; END 13900.0 ms = frame 834 (tail 0.0 ms < 1 frame)

## Inspection record
- automated technical, timing, loudness and caption-geometry checks: automated — 20 checks recorded
- full playback: not-performed — This environment cannot watch video in real time; review preview_540x960.mp4 in a player.
- visual review of cuts.jpg: agent-visual — 3 cuts: code editor → roadmap (3.933) and document → app window (9.900) are hard cuts onto composed frames; the 6.767 take join falls mid-whip and is hidden by the motion blur. Polish note: the inner zoom on the code editor (origin x 0.3) brings the first code line to the window's left edge — set origin x ≈ 0.05 in the brief to keep padding. No faces/camera (presenter never looks at the lens; logged).
- visual review of contact.jpg: agent-visual — Cover title on frame 0 over the lowered editor; typing, roadmap crosses, FOREVER stamp, ship + streamed answer all legible at phone scale; captions in the 1267–1536 zone; no black/frozen frames.

## Decisions
- voice = "src-b57a30f7" (default): clean mic used as the voice once alignment was verified
- takes = "last-complete" (preset): creator workflow default; earlier take only for audible defects
- luxury.gaze = "69 CV head-pose samples (head orientation, not measured eye gaze)" (default): camera shown only while head orientation says the presenter looks at the lens
- luxury.split-transform = {"s":1.4765625,"X":-206.83436715602875,"Y":1069.7292836904526,"headTop":1126} (preset): one transform shared by card footage and head matte
- luxury.music = {"bpm":100,"key":"G","seed":8148} (preset): original synthesized bed, one flat gain to −24 LUFS, no ducking

Render timings: captionsSec 17 s, audioSec 28 s, graphicsSec 123 s, videoSec 26 s, totalSec 200 s.
