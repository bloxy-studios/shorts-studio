# Implementation checklist

Status legend: [x] done and tested · [~] partial (limits stated) · [ ] not done.
Evidence for each item: `docs/VALIDATION.md`.

## 1. Foundation
- [x] Repo layout, Bun/TS strict config, zod schemas (project, source, transcript, analysis, candidate, EditPlan, QA, render, brief, preset, job)
- [x] Flick time math, intervals/tiling, piecewise TimeMap with J-cut lip-sync invariant
- [x] Caption retime/grouping/emphasis/exports with tests
- [x] Plan validation, rule precedence, atomic store, stage cache + cancellation
- [x] Six editorial presets, six caption styles, platform guides, Luxury tokens (validated)
- [x] Bundled OFL fonts (Poppins, Instrument Serif, Inter, Anton, Fredoka)
- [x] Project-local runtime: Python venv, HyperFrames 0.8.97 + GSAP 3.14.2 + Chrome 152, whisper.cpp (pinned commit), models
- [x] Plugin manifest, SessionStart hook, self-locating `bin/shorts-studio`, `doctor` (+ `--setup`)
- [x] Compatibility record (docs/COMPATIBILITY.md)

## 2. First vertical slice (local talking head → MP4)
- [x] ingest (hash, probe incl. rotation/VFR/HDR, proxy, audio), VAD-chunked transcription with coverage verification
- [x] caption state render (HyperFrames) + frame-exact band compositor, final encode, QA + report

## 3. Moment discovery
- [x] scenes (scdet + black detection), audio features/VAD, faces/tracks, frame sheets, agent observations
- [x] rubric scoring + penalties, diversity/IoU, honest shortfall, previews, sentence-aware boundaries

## 4. YouTube acquisition
- [x] URL normalization, yt-dlp adapter with diagnosis + bounded recovery, best-effort subtitles, decode verification
- [x] end-to-end on a public-domain YouTube source (ISS interview)

## 5. Framing
- [x] speaker↔track association from normalized mouth activity, hysteresis/min-hold crop planner, two-shot/stack fallbacks, jump-cut punch-ins
- [~] dense clip-level audiovisual speaker detection (a laughing listener can still be misattributed; fixed by revision + frame review)

## 6. Style interaction
- [x] six caption previews on the same excerpt + comparison sheet; skills require AskUserQuestion after showing them; decisions recorded
- [~] a full interactive guided run of the installed plugin (must be done in an interactive session)

## 7. Creator workflow
- [x] camera↔mic sync (GCC-PHAT windows, direct-path preference, drift fit, spot checks with inconclusive/mismatch states, transcript fallback)
- [x] take grouping (content-word similarity), last-complete-take policy, defect swaps, chatter/false starts, measured endpoints, pause compression, J-cuts, `edit/final.mp4`

## 8. Luxury Tech
- [x] DESIGN.md, eye-contact-gated layout planner (3 layouts, ≤ 8 s runs, no repeats, logged exceptions)
- [x] static camera geometry; split card + head matte from the same clip/transform (HyperFrames remove-background), matte QA + contained-card fallback
- [x] word-anchored graphics brief → HyperFrames compositions (cards, lists, tiles, code, chat/UI demo, document + stamp, radar, image/source capture, connectors), world camera (glide/step/push/pull/whip), DOF, inner zoom
- [x] velocity motion blur + 240→60 sub-frame mode, verified on a moving test edge
- [x] frame-zero cover + separate cover image, real-keyword CTA overlay (only when spoken/briefed)
- [x] synthesized music/SFX/riser, END-length stems, unity mix, measured loudness/true peak, SFX vocabulary validation
- [x] real source-page capture (`capture`: pinned headless Chrome + provenance) and the fixed source-page frame over a washed blurred clone with word-anchored pans

## 9. Adaptive director
- [x] DIRECTOR_BRIEF + BriefConstraints generation, refinement from feedback/QA with change log, bounded repair loop (passes + minutes)
- [x] PREFERENCES.md (explicit vs tentative, workspace default only on request), reference import with retained original, workspace brand presets

## 10. Packaging
- [x] revise (typed ops incl. caption corrections, voice chain), export bundles (+ HyperFrames sources, Drive adapter refuses without a connector), HTML review page
- [x] docs (README, SETUP, COMPATIBILITY, COLOR, LICENSES, VALIDATION), examples/, release packaging + validated local-marketplace install
- [x] HDR (PQ/HLG) → SDR LUT path, verified
