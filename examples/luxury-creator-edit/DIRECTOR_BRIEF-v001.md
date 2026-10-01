# DIRECTOR_BRIEF — creator-luxury/creator-edit brief-v001

Preset **luxury-tech** · plan v5 · created 2026-10-01T12:39:19.238Z. Precedence: current explicit user instructions → preset + saved project overrides → this brief → renderer defaults.

## 1. Editorial intent
- Goal: a premium Luxury Tech short of the astronaut's case that Moon technology benefits everyone
- Audience: generic-9x16 viewers watching muted-first on a phone
- Hook preserved: “It's going to benefit humanity in almost every way.”
- Payoff preserved: “So now I think this Artemis program will take us that next step in proving out these systems.”

## 2. Input evidence (with confidence)
- voice: src-8580d35b — clean mic used as the voice once alignment was verified — confidence 0.85 (plan v5)
- takes: last-complete — creator workflow default; earlier take only for audible defects — confidence 0.85 (plan v5)
- luxury.gaze: 123 CV head-pose samples (head orientation, not measured eye gaze) — camera shown only while head orientation says the presenter looks at the lens — confidence 0.85 (plan v5)
- luxury.split-transform: {"s":1.4765625,"X":-418.22735130786896,"Y":1027.555291724205,"headTop":1126} — one transform shared by card footage and head matte — confidence 0.85 (plan v5)
- luxury.music: {"bpm":106,"key":"A","seed":27999} — original synthesized bed, one flat gain to −24 LUFS, no ducking — confidence 0.85 (plan v5)
- src-8580d35b aligned to src-98c64710: gcc-phat-windowed+envelope-coarse, confirmed; residual 0.00 ms; spot checks 2/3 ok, 1 inconclusive — confidence 1.00 (sync.json)
- L1 take choice: single take — confidence 0.90 (creator-report.md)
- L2 take choice: single take — confidence 0.90 (creator-report.md)
- L3 take choice: single take — confidence 0.90 (creator-report.md)
- L4 take choice: single take — confidence 0.90 (creator-report.md)
- L5 take choice: single take — confidence 0.90 (creator-report.md)
- L6 take choice: single take — confidence 0.90 (creator-report.md)
- L7 take choice: single take — confidence 0.90 (creator-report.md)

## 3. Timing, takes and cut rules
- **lt-preroll** (preset): Pre-roll before the first word [40 ms ±15]
- **lt-pause-compress** (preset): Quiet stretches over 250 ms compress toward 120 ms; natural short pauses stay
- **lt-jcut** (preset): Interior joins may use audio-only J-cuts with voice leading picture by ~50 ms; never before timeline zero [50 ms]
- **lt-tail-fade** (preset): Hold outgoing tail through natural decay then fade up to ~170 ms without speech overlap [170 ms]
- **lt-quiet-join** (preset, hard): No unintended quiet stretch longer than 150 ms at a join [150 ms]
- **plan-end** (brief, hard): END 24.550 s = 1473 frames; last voice sample 24.550 s; no frozen/silent tail [1473 frames]
- **take-L1** (brief, hard): L1: use f1 — single take
- **take-L2** (brief, hard): L2: use f2 — single take
- **take-L3** (brief, hard): L3: use f3 — single take
- **take-L4** (brief, hard): L4: use f4 — single take
- **take-L5** (brief, hard): L5: use f5 — single take
- **take-L6** (brief, hard): L6: use f6 — single take
- **take-L7** (brief, hard): L7: use f7 — single take
- seg001 (L1/f1): source 00:01.780 → output 0.000–2.733 s
- seg002 (L2/f2): source 00:04.280 → output 2.733–4.917 s — audio leads picture by 50 ms (J-cut)
- seg003 (L2/f2): source 00:06.480 → output 4.917–10.100 s
- seg004 (L3/f3): source 00:11.300 → output 10.100–12.300 s — audio leads picture by 50 ms (J-cut)
- seg005 (L4/f4): source 00:13.370 → output 12.300–15.683 s — audio leads picture by 50 ms (J-cut)
- seg006 (L5/f5): source 00:16.420 → output 15.683–17.800 s — audio leads picture by 50 ms (J-cut)
- seg007 (L6/f6): source 00:18.370 → output 17.800–19.533 s — audio leads picture by 50 ms (J-cut)
- seg008 (L6/f6): source 00:20.150 → output 19.533–19.850 s
- seg009 (L7/f7): source 00:20.250 → output 19.850–24.550 s — audio leads picture by 50 ms (J-cut)

## 4. Layout runs, crops and allowed motion
| Run | Time (s) | Layout | Graphic | Caption zone | Why |
| --- | --- | --- | --- | --- | --- |
| run001 | 0.000–2.733 | lt-split | Benefits for all of humanity | 941–1114 | hook: hook sentence → split; looks at lens (100% of 14 samples) |
| run002 | 2.733–10.100 | lt-full-visual | Radar → smarter systems → autonomous cars | 1267–1536 | body: point → full visual (alternating) |
| run003 | 10.100–12.300 | lt-split | What a Moon landing needs | 941–1114 | body: single card → split; looks at lens (100% of 11 samples) |
| run004 | 12.300–15.683 | lt-full-camera | — | 1267–1536 | body: opinion/direct-to-camera line → full camera; looks at lens (100% of 17 samples) |
| run005 | 15.683–19.850 | lt-split | Cars and airplanes that drive and fly themselves | 941–1114 | body: single list → split; looks at lens (100% of 10 samples); looks at lens (93% of 11 samples) |
| run006 | 19.850–24.550 | lt-full-camera | — | 1267–1536 | outro: outro → full camera; looks at lens (100% of 23 samples) |

- **lt-hard-cuts** (preset, hard): Hard picture cuts at every layout join; no wipes or forced transitions across camera footage
- **lt-run-length** (preset): No uninterrupted layout run longer than ~8 s; avoid consecutive runs of the same layout [8 s ±1]
- **lt-hook-split** (preset): First sentence/hook uses the split layout; CTA/outro uses full camera
- **lt-eye-contact** (preset): Show camera only while the presenter appears to look at the lens; otherwise full visual
- **lt-static-footage** (preset, hard): No zoom, pan, punch-in or movement applied to source camera footage; crops are fixed per run
- **crop-lt-fullcam** (brief, hard): lt-fullcam: one held crop — Luxury full camera: one stable cover-fit crop decided at setup (no pan/zoom/punch-in)
- **crop-lt-card** (brief, hard): lt-card: one held crop — split camera card: source × 1.4766 at (-418, 1028)
- **crop-lt-head** (brief, hard): lt-head: one held crop — head matte band: same frame and transform as the card

## 5. Captions
- **lt-caption-start** (preset, hard): Captions start at the first output frame after frame zero
- **lt-highlight-semantic** (preset, hard): Yellow Instrument Serif italic highlight on 1-2 meaningful words after 2-3 normal chunks; never consecutive chunks or function words
- **captions-style** (brief, hard): style luxury-tech v1.0.0; 29 chunks; first caption ≥ 16.7 ms; highlighted: nuances, autonomous, humanity, starting, themselves., program, proving

## 6. Graphics
- **lt-graphics-density** (preset): One dominant subject and at most one supporting cue per run
- **lt-landing-frame** (preset, hard): First frame of each run is a sharp composed landing state with no residual blur
- **lt-real-ui** (preset, hard): Use real captures or reconstructions grounded in official material; disclose reconstructions; never fabricate official screenshots or capabilities
- **graphic-run001** (brief): run001 "Benefits for all of humanity": 1 item(s); world camera step 0.02–0.52 s → (540, 470) ×1.00
- **graphic-run002** (brief): run002 "Radar → smarter systems → autonomous cars": 5 item(s); world camera step 3.78–4.28 s → (1570, 675) ×1.00; whip 5.53–6.58 s → (2690, 675) ×1.00
- **graphic-run003** (brief): run003 "What a Moon landing needs": 1 item(s); world camera glide only
- **graphic-run005** (brief): run005 "Cars and airplanes that drive and fly themselves": 2 item(s); world camera step 1.96–2.46 s → (540, 480) ×1.00

## 7. Audio
- **lt-voice-lufs** (preset): Voice stem integrated loudness [-14 LUFS ±0.5]
- **lt-music-lufs** (preset): Music stem integrated loudness, one flat gain, no ducking or automation [-24 LUFS ±0.5]
- **lt-true-peak** (preset, hard): Master true peak [-1 dBTP]
- **lt-sfx-meaningful** (preset, hard): One synthesized sound per meaningful visible event; none on layout cuts, steps, pushes, glides or ordinary zooms
- **lt-whoosh-whip** (preset, hard): Whoosh only for a graphics whip, peak at whip midpoint; max 1 per run and 3 per short; vary variants
- **lt-synth-only** (preset, hard): Music and SFX are synthesized in code; no stock audio
- **audio-voice** (brief): voice from src-8580d35b; chain hp 80 Hz, denoise light, de-ess true, compress true; target -14 LUFS [-14 LUFS ±0.5]
- **audio-music** (brief): synth music 106 BPM key A seed 27999; -24 LUFS one flat gain; ducking false; fade-out 800 ms ending at END [-24 LUFS ±0.5]
- **audio-sfx** (brief, hard): 3 SFX tied to visible events: 1× whoosh, 1× chime, 1× pop
- **audio-riser** (brief): intro riser 2.33 s ending at 2.733 s (hook → first point), -14 dB re voice peak
- **audio-master** (brief, hard): master -14 LUFS integrated, ≤ -1 dBTP true peak measured on the delivered AAC [-1 dBTP]

## 8. Export, QA, fallbacks and stop criteria
- **lt-60fps** (preset, hard): Deliver 1080x1920 at 60 fps
- **export-profile** (brief, hard): 1080x1920 @ 60/1 fps, H.264 high yuv420p crf 16 preset slow, AAC 192 kbps 48000 Hz 2 ch
- QA checks: export.spec, export.decode, audio.loudness, audio.true-peak, audio.stem-length, captions.sync, captions.safe-area, captions.face-collision, video.black-frozen, timing.end, luxury.layouts, luxury.static-footage, luxury.landing-sharp, luxury.caption-zones, luxury.highlights, luxury.sfx-rules, luxury.matte, luxury.ground, luxury.cover-frame
- Stop: at most 3 automatic repair pass(es) or 45 min; no hard QA failure may remain — otherwise the output is a blocked/draft deliverable.

## 9. Conflicts
- none detected

## 10. Change log
- ∅ → brief-v001 (initial): initial brief from plan v5 — evidence: plan v5, preset luxury-tech 1.0.0
