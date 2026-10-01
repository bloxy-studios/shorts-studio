# Engineering guide

Read `ARCHITECTURE.md` first. This file is the contract every contributor (human or agent)
follows so modules integrate without surprises.

## Layout and ownership

| Path | What lives there |
| --- | --- |
| `packages/core/src/` | Pure TypeScript (no I/O except `store.ts`): schemas, time, intervals, time map, captions, plan validation, precedence, coverage, moments, takes, framing, and `luxury/` (layout planner, world camera + motion blur, graphics brief compiler). Import via `packages/core/src/index.ts` (luxury modules directly). |
| `packages/adapters/src/` | Side effects: `proc.ts` (subprocess, optional binary stdout), `env.ts` (paths), `tools.ts`, `python.ts` (`py()` bridge), `media/` (probe, ffmpeg, `color.ts` HDR LUT path), `acquire/`, `asr/`, `hyperframes.ts` (lint/render/snapshot/remove-background), `presets.ts`, `render/captions.ts`, `render/luxury.ts` (+ icons). |
| `packages/cli/src/` | Commands (`commands/*.ts`), planner (`plan/`), Luxury (`luxury/`: gaze, geometry, plan, render), director (`director/`: brief, repair), renderer (`render/`), QA (`qa/` + `qa/luxury.ts`), report, registry (`registry.ts` + `registry.ext.ts`). |
| `python/shorts_studio_py/` | Python helpers invoked only through `py("<command>", args)`; core commands in `__main__.py`, feature modules auto-discovered as `ext_*.py` (synth, preview, matte, motion, color). |
| `scripts/` | `gen-cli-reference.ts` (regenerates `references/cli.md` from the registry), `package-plugin.ts` (clean `release/` + validation). |
| `presets/`, `templates/`, `assets/fonts/` | Data and templates (read-only at runtime). |
| `tests/core`, `tests/cli`, `tests/python`, `tests/integration` | `bun test tests/core tests/cli`; `.runtime/venv/bin/python -m pytest tests/python`. |

## Non-negotiable conventions

1. **Time** is integer flicks everywhere (`packages/core/src/time.ts`). Picture boundaries are
   frame-aligned (`quantizeToFrame`), audio boundaries sample-aligned (`quantizeToSample`).
   Intervals are half-open `[start, end)`. Never store float seconds in schemas.
2. **EditPlan is the single source of truth.** Renderers, QA, subtitles and reports read only
   the plan (plus sources/analysis). New plan versions are written with `savePlan`; plans are
   never mutated in place. After changing `segments`, recompute `timeMap` with
   `buildTimeMapPieces` and run `validatePlan` — errors block rendering.
3. **Subprocesses** use `run([...args])` from `adapters/src/proc.ts` (argument arrays, never a
   shell string; secrets redacted). Resolve binaries with `tool("ffmpeg")` etc.
4. **Python** is called with `py<T>("module.command", args)`; inputs/outputs are JSON; times
   crossing the boundary are flicks or explicitly named `...S`/`...Ms` fields.
5. **Stages** that are expensive go through `runStage(p, name, inputs, fn)` so they are cached by
   input hash, resumable, and cancellable (Ctrl-C).
6. **Honesty**: never claim an analysis/visual check that did not run. Use `analysisLevel`,
   coverage records, QA `not-run` / `not-performed` statuses, and report limitations.
7. **No global installs** (no sudo, npm -g, global pip). Runtime lives in `paths().runtimeHome`.
8. **Style**: TypeScript strict, explicit types on exports, small focused functions, immutable
   updates (`{...x}`), Zod for anything read from disk. No `console.log` in library code —
   use `ui.ts` (`info`, `stage`, `warn`) in the CLI.
9. **Tests** cover behaviour that would damage timing, speech, crops or exports — not file
   existence. Add focused unit tests next to the feature (`tests/<area>/*.test.ts`).

## Commands

Each command is a `Command` (`summary`, `usage`, `run(args)`) registered in
`packages/cli/src/registry.ts` (core) or `registry.ext.ts` (feature modules: one import + one
spread). Commands return `{ json, human }`; `--json` prints `json` only. After adding or changing a
command, run `bun scripts/gen-cli-reference.ts` so `references/cli.md` (used by skills) stays exact.

## Machine limits (reference: Intel i5-7300U, 4 threads, 8 GB)

- HyperFrames captures ~1–3 fps (caption states) to ~4–7 fps (graphics) at 1080×1920; background
  removal ~1.6 s/frame on CPU. Render only designed layers; footage is always processed by FFmpeg.
- Composite overlays in YUV (`overlay=format=yuv420` after an explicit BT.709 `scale … format=yuva420p`);
  `format=auto` with RGBA input shifts every flat colour.
- Do not run two renders, transcriptions or CV passes concurrently on this machine.
- Prefer the 360p analysis proxy for CV and sheets of source frames.

## Useful entry points

```ts
import { loadProject } from "packages/cli/src/project.ts";
import { loadSource, defaultSource } from "packages/cli/src/commands/ingest.ts";
import { loadTranscript } from "packages/cli/src/commands/transcribe.ts";
import { loadVisual, loadAudioFeatures, ensureAudioFeatures } from "packages/cli/src/commands/analyze.ts";
import { loadPlan, savePlan, nextPlanVersion } from "packages/cli/src/plans.ts";
import { renderClip } from "packages/cli/src/render/pipeline.ts";
import { runQA } from "packages/cli/src/qa/checks.ts";
import { loadPreset, loadCaptionStyle } from "packages/adapters/src/presets.ts";
```

Demo projects for manual runs: `projects/artemis-demo` (NASA reel, `clip-01`),
`projects/iss-interview` (YouTube end-to-end, revised + approved), `projects/creator-luxury`
(Creator Edit + Luxury Tech, all three layouts) and `projects/creator-takes` (retake session,
eye-contact exception path). Fixtures: `tests/fixtures/README.md`.
