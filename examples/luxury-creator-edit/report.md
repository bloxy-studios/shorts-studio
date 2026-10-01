# creator-edit · render r003 · plan v5

**QA verdict:** PASS WITH WARNINGS — no hard failures; see findings. 19 passed, 1 warning(s), 0 hard failure(s). Visual review of the frame sheets is recorded below.

## Deliverables
- video: `projects/creator-luxury/clips/creator-edit/renders/r003/creator-luxury_creator-edit_v5_r003.mp4`
- preview: `projects/creator-luxury/clips/creator-edit/renders/r003/preview_540x960.mp4`
- cover: `projects/creator-luxury/clips/creator-edit/renders/r003/cover.jpg`
- master: `projects/creator-luxury/clips/creator-edit/renders/r003/master.wav`
- plan: `projects/creator-luxury/clips/creator-edit/renders/r003/editplan.json`
- srt: `projects/creator-luxury/clips/creator-edit/renders/r003/captions.srt`
- vtt: `projects/creator-luxury/clips/creator-edit/renders/r003/captions.vtt`
- wordsJson: `projects/creator-luxury/clips/creator-edit/renders/r003/captions.words.json`
- stem_voice: `projects/creator-luxury/clips/creator-edit/renders/r003/stems/voice.wav`
- stem_music: `projects/creator-luxury/clips/creator-edit/renders/r003/stems/music.wav`
- stem_sfx: `projects/creator-luxury/clips/creator-edit/renders/r003/stems/sfx.wav`
- stem_riser: `projects/creator-luxury/clips/creator-edit/renders/r003/stems/riser.wav`
- qa: `projects/creator-luxury/clips/creator-edit/renders/r003/qa.json`
- report: `projects/creator-luxury/clips/creator-edit/renders/r003/report.md`

## Source
- src-98c64710: camera.mp4
  26.80 s, 1280x720 @ 30 fps, bt709; acquisition local
- src-8580d35b: mic.wav
  28.70 s; acquisition local
- Analysis coverage: transcript none, visual cv-only, audio full; 134 frames sampled.
  - limitation: no transcript yet — run transcribe
  - limitation: visual evidence is sampled (5 fps faces, 12 sheet frames)
  - limitation: no agent inspection recorded yet: reactions/visual jokes are unverified (cv-only)

## Timing
- Output: 1080x1920 @ 60 fps, 48000 Hz.
- Exact final voice sample: 24550.0 ms; frame-aligned END: 24550.0 ms = 1473 frames.

| segment | output | source | words |
| --- | --- | --- | --- |
| seg001 | 00:00.000–00:02.733 | src-98c64710 00:01.780–00:04.513 | 9 |
| seg002 | 00:02.733–00:04.917 | src-98c64710 00:04.280–00:06.463 | 5 |
| seg003 | 00:04.917–00:10.100 | src-98c64710 00:06.480–00:11.663 | 13 |
| seg004 | 00:10.100–00:12.300 | src-98c64710 00:11.300–00:13.500 | 11 |
| seg005 | 00:12.300–00:15.683 | src-98c64710 00:13.370–00:16.753 | 10 |
| seg006 | 00:15.683–00:17.800 | src-98c64710 00:16.420–00:18.537 | 6 |
| seg007 | 00:17.800–00:19.533 | src-98c64710 00:18.370–00:20.103 | 5 |
| seg008 | 00:19.533–00:19.850 | src-98c64710 00:20.150–00:20.467 | 0 |
| seg009 | 00:19.850–00:24.550 | src-98c64710 00:20.250–00:24.950 | 18 |

## Layout runs
| run | output | frames | layout | caption zone | reason |
| --- | --- | --- | --- | --- | --- |
| run001 | 00:00.000–00:02.733 | 164 | lt-split | y 941–1114 | hook: hook sentence → split; looks at lens (100% of 14 samples) |
| run002 | 00:02.733–00:10.100 | 442 | lt-full-visual | y 1267–1536 | body: point → full visual (alternating) |
| run003 | 00:10.100–00:12.300 | 132 | lt-split | y 941–1114 | body: single card → split; looks at lens (100% of 11 samples) |
| run004 | 00:12.300–00:15.683 | 203 | lt-full-camera | y 1267–1536 | body: opinion/direct-to-camera line → full camera; looks at lens (100% of 17 samples) |
| run005 | 00:15.683–00:19.850 | 250 | lt-split | y 941–1114 | body: single list → split; looks at lens (100% of 10 samples); looks at lens (93% of 11 samples) |
| run006 | 00:19.850–00:24.550 | 282 | lt-full-camera | y 1267–1536 | outro: outro → full camera; looks at lens (100% of 23 samples) |

## Framing
- lt-fullcam (main): static crop x=446 y=0 405x720; confidence 0.90; Luxury full camera: one stable cover-fit crop decided at setup (no pan/zoom/punch-in)
- lt-card (card): static crop x=283 y=117 731x488; confidence 0.90; split camera card: source × 1.4766 at (-418, 1028)
- lt-head (head): static crop x=283 y=42 731x102; confidence 0.85; head matte band: same frame and transform as the card

## Captions
- Style luxury-tech v1.0.0; 29 chunks; first caption at 33.3 ms; retimed from the EditPlan time map (not raw transcript times).
- Rendered as 29 HyperFrames state frame(s) and composited frame-exactly into a band at y=894–1546.
- Emphasized words: nuances, autonomous, humanity, starting, themselves., program, proving.
- Uncertain words shown as transcribed (review): in @ 00:23.201.
- Exports: SRT/VTT contain spoken words only; authored titles are never exported as speech.

## Audio
- Policy: voice-only; voice chain {"highpassHz":80,"denoise":"light","deess":true,"compress":true,"targetLufs":-14}; music synth; 3 SFX event(s).
| stem | samples | integrated | sample peak | true peak | note |
| --- | --- | --- | --- | --- | --- |
| voice | 1178400 | -14.08 LUFS | -1.90 dBFS | -1.88 dBTP |  |
| music | 1178400 | -24.00 LUFS | -9.31 dBFS | -9.30 dBTP |  |
| sfx | 1178400 | -24.20 LUFS | -10.90 dBFS | -10.89 dBTP | sparse stem (8% of samples above -60 dBFS): gated integrated loudness reflects only its audible events |
| riser | 1178400 | -27.31 LUFS | -15.90 dBFS | -15.86 dBTP | sparse stem (7% of samples above -60 dBFS): gated integrated loudness reflects only its audible events |
| master | 1178400 | -13.72 LUFS | -1.90 dBFS | -1.89 dBTP |  |

## QA findings
- [PASS] export.spec (hard): H.264 1080x1920 yuv420p @ 60 fps, 1473 frames, AAC 48000 Hz 2 ch
- [PASS] export.decode (hard): entire file decodes without errors
- [PASS] audio.loudness (soft): delivered integrated loudness -13.70 LUFS (target -14 ±1.0 after AAC; master WAV -13.72 LUFS)
- [PASS] audio.true-peak (hard): delivered true peak -1.80 dBTP (ceiling -1 dBTP)
- [PASS] audio.stem-length (hard): 4 stem(s) all exactly 1178400 samples (END)
- [WARN] captions.sync (hard): 28/29 caption chunks overlap measured speech in the final mix; median onset lag 0 ms → repair: rebuild captions from the time map; check for dropped words at cuts
- [PASS] captions.safe-area (soft): all rendered caption bounds stay inside the generic-9x16 guide margins (approximate guides)
- [PASS] captions.face-collision (soft): no rendered caption overlaps a detected face (5 fps face samples)
- [PASS] video.black-frozen (soft): no black or frozen stretches detected
- [PASS] luxury.layouts (soft): 3 split / 1 full visual / 2 full camera; hook=split, outro=full-camera
- [PASS] luxury.static-footage (hard): 3 camera crop(s), each a single held transform (no pan/zoom/punch-in on footage)
- [PASS] luxury.landing-sharp (hard): every run lands sharp (σ=0 on frame 0 and at rest); blur on 108 moving frame(s), peak σ 29.3 px ≤ 40
- [PASS] luxury.caption-zones (soft): all 29 caption states sit inside their run's zone (split 941–1114, full camera/visual 1267–1536)
- [PASS] luxury.highlights (hard): 7 highlighted chunk(s) of 29: nuances, autonomous, humanity, starting, themselves., program, proving; Instrument Serif italic #FFFF00; first caption at frame 2
- [PASS] luxury.sfx-rules (hard): 3 SFX tied to visible graphics events (whoosh, chime, pop); 1 whip(s) with whoosh at the midpoint; none on layout cuts; riser ends at the hook join 2.733 s
- [PASS] luxury.matte (hard): 5 split piece(s): matte frame-to-frame IoU ≥ 0.956, frame-aligned with the card footage (same clip, probe-verified)
- [PASS] luxury.ground (soft): ground at 4 empty points of frame 385 (run002) within 3.0/255 of the radial #FFFFFF→#F3F3F0 token
- [PASS] luxury.cover-frame (soft): frame 0 carries the cover title box (centre 255,255,255); frame 1 differs by 7/255 there — "Artemis tech for all of us"
- [PASS] luxury.frame-rate (info): delivered at 60 fps; camera footage is 30.00 fps, so footage frames are repeated (no added motion detail); graphics are rendered at a genuine 60 fps
- [PASS] timing.end (hard): voice ends at 24550.0 ms; END 24550.0 ms = frame 1473 (tail 0.0 ms < 1 frame)

## Inspection record
- automated technical, timing, loudness and caption-geometry checks: automated — 20 checks recorded
- full playback: not-performed — This environment cannot watch video in real time; review preview_540x960.mp4 in a player.
- visual review of cuts.jpg: agent-visual — 8 cuts inspected: layout joins split→visual (2.733), visual→split (10.100), split→camera (12.300), camera→split (15.683), split→camera (19.850) are hard cuts onto composed frames; in-run picture cuts (4.917, 17.800, 19.533) are hidden by continuing graphics or are card-only jump cuts. Head break-out clean at every split frame (no ghost band); captions clear of faces; plane tile mid-step at 17.8 s is intended motion.
- visual review of contact.jpg: agent-visual — Frame 0 shows the cover title over the lowered hero card with the head breaking out of the card; radar → car whip, checklist, full-camera opinion, car/plane tiles, full-camera outro all read clearly; highlights on autonomous/humanity/program; no black or frozen frames.
- visual review of contact.jpg: agent-visual — Frame 0 shows the cover title over the lowered hero card with the head breaking out of the card; radar → car whip, checklist, full-camera opinion, car/plane tiles, full-camera outro all read clearly; highlights on autonomous/humanity/program; no black or frozen frames.

## Decisions
- voice = "src-8580d35b" (default): clean mic used as the voice once alignment was verified
- takes = "last-complete" (preset): creator workflow default; earlier take only for audible defects
- luxury.gaze = "123 CV head-pose samples (head orientation, not measured eye gaze)" (default): camera shown only while head orientation says the presenter looks at the lens
- luxury.split-transform = {"s":1.4765625,"X":-418.22735130786896,"Y":1027.555291724205,"headTop":1126} (preset): one transform shared by card footage and head matte
- luxury.music = {"bpm":106,"key":"A","seed":27999} (preset): original synthesized bed, one flat gain to −24 LUFS, no ducking

Render timings: captionsSec 0 s, audioSec 36 s, graphicsSec 3 s, videoSec 158 s, totalSec 212 s.
