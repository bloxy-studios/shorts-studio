# clip-01 · render r002 · plan v2

**QA verdict:** PASS WITH WARNINGS — no hard failures; see findings. 9 passed, 1 warning(s), 0 hard failure(s). Visual review of the frame sheets is still pending.

## Deliverables
- video: `projects/iss-interview/clips/clip-01/renders/r002/iss-interview_clip-01_v2_r002.mp4`
- preview: `projects/iss-interview/clips/clip-01/renders/r002/preview_540x960.mp4`
- cover: `projects/iss-interview/clips/clip-01/renders/r002/cover.jpg`
- master: `projects/iss-interview/clips/clip-01/renders/r002/master.wav`
- plan: `projects/iss-interview/clips/clip-01/renders/r002/editplan.json`
- srt: `projects/iss-interview/clips/clip-01/renders/r002/captions.srt`
- vtt: `projects/iss-interview/clips/clip-01/renders/r002/captions.vtt`
- wordsJson: `projects/iss-interview/clips/clip-01/renders/r002/captions.words.json`
- stem_voice: `projects/iss-interview/clips/clip-01/renders/r002/stems/voice.wav`
- qa: `projects/iss-interview/clips/clip-01/renders/r002/qa.json`

## Source
- src-c40cc113: Christina Koch and Jessica Meir in-flight interviews from ISS — NASA Video (https://www.youtube.com/watch?v=b8K96XHxi7I)
  1434.11 s, 1280x720 @ 60000/1001 fps, bt709; acquisition acquired via yt-dlp 2026.08.19
- Analysis coverage: transcript full, visual agent-inspected, audio full; 4302 frames sampled.
  - limitation: visual evidence is sampled (3 fps faces, 48 sheet frames)
- Transcript: whisper.cpp base.en, language en (user); 132 uncertain word(s) flagged.

## Timing
- Output: 1080x1920 @ 60000/1001 fps, 48000 Hz.
- Exact final voice sample: 32732.7 ms; frame-aligned END: 32749.4 ms = 1963 frames.
- Source range: 07:03.480 → 07:38.370 of src-c40cc113.

| segment | output | source | words |
| --- | --- | --- | --- |
| seg001 | 00:00.000–00:04.304 | src-c40cc113 07:03.473–07:07.777 | 15 |
| seg002 | 00:04.304–00:32.749 | src-c40cc113 07:09.946–07:38.391 | 96 |

## Layout runs
| run | output | frames | layout | caption zone | reason |
| --- | --- | --- | --- | --- | --- |
| run001 | 00:00.000–00:04.321 | 259 | full-crop | y 1180–1460 | revision: keep both people visible (QA found the laughing listener framed at 0:01.4-0:04.3; keep both people visible during this exchange) (exceptions: source resolution limits sharpness: 405 px → 1080 px (2.67× upscale)) |
| run002 | 00:04.321–00:10.477 | 369 | full-crop | y 1180–1460 | two-shot (ambiguous: 2 faces visible; mouth evidence too close to call (ratio 1.25)) (exceptions: source resolution limits sharpness: 405 px → 1080 px (2.67× upscale)) |
| run003 | 00:10.477–00:16.483 | 360 | full-crop | y 1180–1460 | active speaker T44 (confidence 0.72) (exceptions: source resolution limits sharpness: 382 px → 1080 px (2.83× upscale)) |
| run004 | 00:16.483–00:32.749 | 975 | full-crop | y 1180–1460 | two-shot (ambiguous: 2 faces visible; mouth evidence too close to call (ratio 1.16)) (exceptions: source resolution limits sharpness: 405 px → 1080 px (2.67× upscale)) |

## Framing
- crop001 (main): static crop x=385 y=0 405x720; confidence 0.80; two-shot containing T43 + T44: ambiguous: 2 faces visible; mouth evidence too close to call (ratio 1.35)
- crop003 (main): static crop x=386 y=0 405x720; confidence 0.80; two-shot containing T43 + T44: ambiguous: 2 faces visible; mouth evidence too close to call (ratio 1.25)
- crop004 (main): static crop x=285 y=0 382x679; confidence 0.72; speaker T44: T44 mouth activity 1.26× baseline vs 0.82× for the next face (ratio 1.54)
- crop005 (main): static crop x=386 y=0 405x720; confidence 0.80; two-shot containing T43 + T44: ambiguous: 2 faces visible; mouth evidence too close to call (ratio 1.16)

## Captions
- Style word-highlight v1.0.0; 24 chunks; first caption at 33.4 ms; retimed from the EditPlan time map (not raw transcript times).
- Rendered as 109 HyperFrames state frame(s) and composited frame-exactly into a band at y=1186–1458.
- Uncertain words shown as transcribed (review): well @ 00:04.448, Our @ 00:28.778, Earth. @ 00:32.288.
- Exports: SRT/VTT contain spoken words only; authored titles are never exported as speech.

## Audio
- Policy: keep-source-mix; voice chain {"highpassHz":70,"denoise":"light","deess":false,"compress":true,"targetLufs":-14}; music none; 0 SFX event(s).
| stem | samples | integrated | sample peak | true peak | note |
| --- | --- | --- | --- | --- | --- |
| voice | 1571970 | -14.04 LUFS | -1.89 dBFS | -1.88 dBTP |  |
| master | 1571970 | -14.04 LUFS | -1.89 dBFS | -1.88 dBTP |  |

## QA findings
- [PASS] export.spec (hard): H.264 1080x1920 yuv420p @ 60000/1001 fps, 1963 frames, AAC 48000 Hz 2 ch
- [PASS] export.decode (hard): entire file decodes without errors
- [PASS] audio.loudness (soft): delivered integrated loudness -14.00 LUFS (target -14 ±1.0 after AAC; master WAV -14.04 LUFS)
- [PASS] audio.true-peak (hard): delivered true peak -1.80 dBTP (ceiling -1 dBTP)
- [PASS] audio.stem-length (hard): 1 stem(s) all exactly 1571970 samples (END)
- [PASS] captions.sync (hard): 24/24 caption chunks overlap measured speech in the final mix; median onset lag 0 ms
- [WARN] captions.safe-area (soft): 3 caption chunk(s) extend into the generic-9x16 UI guide margins (approximate guides)
- [PASS] captions.face-collision (soft): no rendered caption overlaps a detected face (5 fps face samples)
- [PASS] video.black-frozen (soft): no black or frozen stretches detected
- [PASS] timing.end (hard): voice ends at 32732.7 ms; END 32749.4 ms = frame 1963 (tail 16.7 ms < 1 frame)

## Inspection record
- visual review of cuts.jpg: not-performed (`projects/iss-interview/clips/clip-01/renders/r002/qa/cuts.jpg`) — Awaiting agent/human inspection; record with `shorts-studio qa note`.
- visual review of contact.jpg: not-performed (`projects/iss-interview/clips/clip-01/renders/r002/qa/contact.jpg`) — Awaiting agent/human inspection; record with `shorts-studio qa note`.
- automated technical, timing, loudness and caption-geometry checks: automated — 10 checks recorded
- full playback: not-performed — This environment cannot watch video in real time; review preview_540x960.mp4 in a player.

## Decisions
- preset = "social-dynamic" (user): requested
- captionStyle = "word-highlight" (user): caption style selection

Render timings: captionsSec 0 s, audioSec 19 s, videoSec 127 s, totalSec 164 s.
