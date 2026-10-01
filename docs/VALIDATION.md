# Validation log

Evidence for `ACCEPTANCE.md`, recorded on 2026-10-01 on the reference machine (`docs/COMPATIBILITY.md`).
Paths are relative to the repository; `projects/` and fixtures are reproducible but git-ignored, and
small copies live in `examples/`. "Pass" below always means a measured check, never only an exit code.

## Automated suites

| Command | Result |
| --- | --- |
| `bun test tests/core tests/cli` | 98 tests, 0 failures (16 files: time/flicks, intervals, TimeMap + J-cut lip sync, captions retime/grouping/emphasis/exports, plan validation, precedence, moments, takes (incl. parallel-sentence regression), framing, revise ops, skills frontmatter lint, whisper chunk-tail retiming, Luxury layout planner, world camera + motion blur math, graphics brief compiler incl. source-page) |
| `.runtime/venv/bin/python -m pytest -q tests/python` | 10 tests, 0 failures (sync incl. reverberant direct-path regression, synth stems, matte masks/ramp) |
| `bunx tsc --noEmit -p .` | clean (strict) |
| `claude plugin validate .claude-plugin/plugin.json --strict` | passed (dev checkout); `release/shorts-studio/.claude-plugin/plugin.json --strict` and `release/.claude-plugin/marketplace.json` passed |
| `bun scripts/package-plugin.ts` + `claude plugin marketplace add ./release` + `claude plugin install shorts-studio@shorts-studio` (isolated `CLAUDE_CONFIG_DIR`) | installed 3.7 MB; installed `bin/shorts-studio doctor` → "ready: all required checks pass"; `plugin details` → 20 skills, 2 agents, 1 hook |

## A1 — plugin loads, workflows discoverable

`claude --plugin-dir . plugin details shorts-studio` lists 20 skills (16 user-facing: studio, clip, analyze,
edit, creator-edit, reframe, captions, design, luxury-tech, graphics, audio, preview, revise, export, doctor,
style-learning; internal `user-invocable: false`: ingest, transcribe, quality-check, director), agents
`frame-inspector`, `qa-reviewer`, and the SessionStart hook. Always-on cost ≈ 3.4k tokens.

## A2 — `/clip` on an accessible source

`projects/iss-interview` (NASA ISS interview, YouTube `b8K96XHxi7I`, 1434 s, 59.94 fps) — acquired with
yt-dlp 2026.08.19 (subtitle 429 handled as best-effort), transcribed, analyzed (scenes, faces at 5 fps,
audio events, frame sheets inspected and 5 observations recorded), 7 candidates ranked with evidence
(3 rejected with reasons: weak delivery / below the quality bar), clip-01 planned from c-003
"Do astronauts age less in space?", rendered, revised, approved (r002) and exported
(`exports/2026-10-01-iss-interview/clip-01`, 17 files incl. manifest with sha256). Copy: `examples/youtube-clip/`.

## A3 — analysis level is honest

Each candidate carries `analysisLevel` (`audiovisual-agent` when agent observations from inspected sheets
contributed, `audiovisual-cv` otherwise, `transcript-only` when no picture analysis exists); forced
transcript-only labelling is covered by `tests/core/moments.test.ts`. Reports state coverage
("sampled frames are not frame-by-frame viewing").

## A4 — interactive choices with visual samples

`shorts-studio preview captions artemis-demo --range 0:23.3-0:30.2` rendered the same excerpt in all six
caption styles + `review/captions/0023300-0030200/caption-styles.jpg`; the `clip`/`captions`/`preview`
skills require reading that sheet before an AskUserQuestion (≤ 4 options, recommended first). The
build's own product questions were asked with the real AskUserQuestion tool. **Not performed:** a full
guided run of the installed plugin in a separate interactive session (AskUserQuestion is unavailable to
`-p`/subagents); do one by running `/shorts-studio:clip` interactively.

## A5 — speaker-aware framing, safe degradation

ISS interview v1 switched to a laughing listener at 0:01.4–0:04.3 (QA + frame review). Revision
`keep-both-visible` (v2) replaced exactly runs 001–002 with a two-shot reusing the neighbouring crop
(`crop001`); runs 003–005 unchanged. Off-camera/low-confidence speech keeps a wide or stack layout
(`planShots` thresholds: off-camera < 1.12, on-screen ≥ 1.3 ratio and ≥ 1.25). Luxury Tech degrades
camera layouts by eye contact (below).

## A6 — caption timing after cuts / J-cuts; subtitle exports

Unit tests (retime through the TimeMap, J-cut lead, partial words). QA `captions.sync` on renders:
creator-luxury r003 28/29 chunks overlap measured speech, median onset lag 0 ms; the one miss ("So I say",
12.30 s) is a whisper word-timing error at a line start (energy starts at ~12.45 s) — reported as a warning,
not hidden. Every render writes `captions.srt`, `captions.vtt`, `captions.words.json`.

## A7 — Creator Edit

| Fixture | Sync (truth) | Takes (truth) |
| --- | --- | --- |
| creator-takes | offset 2.39995 s (2.4 s), residual 0.002 ms, spot checks 3/3 ok | L1 last complete take; L2/L3 single (false start "every feature you add is our" removed); L4 earlier take swapped in because the last take stutters ("and and") — all match `truth.json`; 5 chatter items removed |
| creator-luxury | 1.29997 s (1.3 s), residual 0.002 ms; spot checks 2 ok, 1 inconclusive (weak peak) | 7 single-take lines; parallel sentences "Cars…/Airplanes… themselves" kept as separate lines (regression fixed) |
| creator-sync (drifting) | 1.74877 s (1.75 s); drift fitted 24.2 ppm (40 ppm) → ≤ 1.2 ms error over 75 s; status confirmed by window agreement; all 3 spot checks inconclusive on the heavily degraded camera audio (reported as such) | — |

`edit/final.mp4` is written for approved creator edits (`projects/creator-luxury/edit/final.mp4`,
`projects/creator-takes/edit/final.mp4`). Reports: `examples/*/creator-report.md`.

## A8 — Luxury Tech representative edit

`projects/creator-luxury` render r003 (plan v5), copy in `examples/luxury-creator-edit/`:

- Layout runs (eye-contact gated, all 3 layouts, no consecutive repeats): split · full visual · split · full
  camera · split · full camera; hook split, outro full camera; `layout-runs.md`.
- QA (20 checks, verdict pass-with-warnings): `export.spec` 1080×1920 yuv420p @ 60 fps, 1473 frames;
  `luxury.static-footage` (3 held crops); `luxury.landing-sharp` (σ = 0 on every run's first frame and at rest;
  blur on 108 moving frames, peak σ 29.3 px ≤ 40); `luxury.caption-zones`; `luxury.highlights` (7 highlighted
  chunks, Instrument Serif italic #FFFF00, no function words, none consecutive, first caption at frame 2);
  `luxury.sfx-rules` (whoosh exactly at the whip midpoint, riser ends at the hook join 2.733 s, nothing on cuts);
  `luxury.matte` (5 split pieces, frame-to-frame IoU ≥ 0.956, alignment probe: matte frame N matches card
  frame N better than N+1); `luxury.ground` (empty ground within 4/255 of the token after the overlay
  colour fix); `luxury.cover-frame`; `luxury.frame-rate` (30 fps footage repeated; graphics genuine 60 fps).
- Visual review recorded (`qa note`): head/card join seamless after fixing a centred feather that ghosted
  the hair (r001 → r002), cut sheet of all 8 cuts inspected.
- Exception path: `projects/creator-takes` (presenter looks ~25° off-axis, 0 % at-lens) → camera layouts
  withheld and logged; UI demonstrations carry the edit (`examples/creator-takes-luxury/`).

## A9 — stems

creator-luxury r003, all stems exactly END = 1 178 400 samples @ 48 kHz (`audio.stem-length` pass):

| Stem | Integrated LUFS | Sample peak dBFS | True peak dBTP | Note |
| --- | --- | --- | --- | --- |
| voice | −14.08 | −1.90 | −1.88 | target −14 (±0.5) |
| music | −24.00 | −9.31 | −9.30 | one flat gain, no ducking; 106 BPM, key A, seed 27999 |
| sfx | −24.20 | −10.90 | −10.89 | sparse stem: gated reading reflects only its events |
| riser | −27.31 | −15.90 | −15.86 | sparse stem |
| master (WAV) | −13.72 | −1.90 | −1.89 | unity sum |
| delivered AAC | −13.70 | — | −1.80 | ≤ −1 dBTP ceiling |

## A10 — director refines the brief from a real QA finding

`tests/integration/repair-loop.smoke.ts creator-luxury creator-edit`: injected an unlinked whoosh on a layout
cut (plan v6) → render r004 **blocked** (`luxury.sfx-rules`: whoosh-needs-whip, whoosh-max-per-run,
no-sfx-on-cuts) → `repairLoop` pass 1 → plan v7 removes that event (preset rule unchanged) → r005
pass-with-warnings; `brief/creator-edit/brief-v002.md` change log: "repair pass 1: remove 1 sound event(s)
that break the SFX vocabulary … — evidence: r004/qa015 luxury.sfx-rules". Only implicated stages re-ran:
captions cached (0.005 s), graphics cached (2.5 s), mattes cached; audio re-rendered (33.6 s) + final mux.
A clean render with only unfixable warnings stops immediately ("only findings without a safe automatic fix remain").

## A11 — targeted revision, approved work preserved

ISS v1 → v2 (`keep-both-visible 0:01.351–0:04.321`) changed only the isolated runs; `approved.json` keeps r002;
plan files are never overwritten (`savePlan` refuses an existing version).

## A12 — decodes; checks recorded honestly

Every render has `qa.json` (each check: severity, status incl. `not-run`, evidence) and `report.md`; full decode
check passes on all delivered files. Re-running `shorts-studio qa` reuses the cached caption band and matte QA
(no check silently drops out) and rewrites the record and report. Warnings make the verdict
`pass-with-warnings` regardless of check severity.

## A13 — tests, validation, end-to-end demo

See "Automated suites". End-to-end demo commands: `references/workflows.md`; logs of the runs above are in each
project's render records (`render.json` timings/notes).

## A14 — documentation, examples, no hidden global setup

`README.md`, `docs/SETUP.md` (prerequisites + `doctor --setup`, project-local only), `docs/COMPATIBILITY.md`,
`docs/COLOR.md`, `docs/LICENSES.md`, `ARCHITECTURE.md`, `docs/ENGINEERING.md`, `references/*`,
`presets/luxury-tech/DESIGN.md`, `examples/`. `doctor` on the runtime: all required checks pass.

## Additional verifications

### Motion blur on a moving test graphic (`bun tests/integration/motion-blur.verify.ts`)

Edge carried by the world camera at a constant 1200 px/s; 10–90 % edge width (px):

| Method | At rest | Moving (mean) | Expectation |
| --- | --- | --- | --- |
| Velocity blur (default) | 3.4 | 13.2 | σ = 0.29 × 1200 × 0.75/60 = 4.35 px → 11.7 px incl. the 3.4 px base edge; ideal 0.75 box shutter 12.0 px |
| 240 fps → 60 fps, 3 of 4 samples (linear light) | 2.8 | 10.6 | ≈ 10 px for 3 discrete samples 5 px apart |

Edge positions track the camera within 2 px. The velocity blur is ~13 % wider than its Gaussian prediction
(~6 % from the ideal box shutter); sub-frame integration shows visible 5 px steps at this speed — hence the
smooth velocity blur is the default. Copies: `examples/motion-blur-*`.

### HDR → SDR (`bun tests/integration/hdr.verify.ts`)

PQ and HLG 10-bit clips detected as HDR; neutral patches within 1 code value of the analytic LUT (203-nit
reference white → 244/245, 18 % grey → 125, 1000-nit peak → 255), BT.2020 red keeps its hue; a naive conversion
gives 145 for reference white (washed out). See `docs/COLOR.md`.

### Colour of composited overlays

`overlay=format=auto` with an RGBA caption band shifted flat colours by 3 levels across the whole frame
(Luxury ground #F2F2ED → #EFEFEA, measured); overlays now run in YUV with explicit BT.709 conversion and the
measured ground matches HyperFrames' output.

### Source-page capture

`shorts-studio capture creator-luxury file://…/review/index.html --name review-page` → 1080×2200 PNG +
provenance JSON (URL, time, sha256, tool); a `source-page` run lints, frames it at x 24, y 200, 1032×1040
(r 36) over the washed blurred clone, and pans/zooms inside on the anchored word (snapshots inspected).

### Background removal availability

`hyperframes remove-background --info`: CPU provider only; 90 frames (1280×720) in 268 s; ProRes 4444
`yuva444p12le`, frame count preserved; matte quality checked on a contact sheet before adoption.
