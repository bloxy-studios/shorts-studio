# Shorts Studio — Architecture

Shorts Studio is a Claude Code plugin (`shorts-studio`) whose skills drive one deterministic
CLI (`bin/shorts-studio`, Bun + TypeScript) backed by Python helpers (audio, CV), FFmpeg, and a
pinned HyperFrames renderer. Claude directs: it asks the questions, inspects frame sheets,
writes briefs and plan revisions. Everything that touches media is code.

## 1. Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| Plugin surface | `.claude-plugin/`, `skills/`, `agents/`, `hooks/` | Workflows, routing, questions (main thread only), worker contracts |
| CLI | `packages/cli/` | Deterministic commands: `doctor`, `project`, `ingest`, `transcribe`, `analyze`, `candidates`, `plan`, `render`, `qa`, `revise`, `brief`, `creator`, `preview`, `review`, `export`, `status` |
| Core | `packages/core/` | Zod schemas (EditPlan & friends), flick time math, intervals/tiling, time map, caption grouping/emphasis/exports, plan validation, rule precedence, atomic store |
| Adapters | `packages/adapters/` | Process runner, paths, presets, FFmpeg/ffprobe, yt-dlp, whisper, Python bridge, HyperFrames, destinations |
| Python | `python/shorts_studio_py/` | Audio features/VAD, loudness/true peak, camera↔mic sync + drift, endpoints, synthesis, mixing; face tracking, gaze evidence, matting, frame sheets |
| Presets | `presets/` | Editorial presets, caption styles, platform guides, Luxury Tech tokens + DESIGN.md |
| Templates | `templates/` | HyperFrames compositions (caption states, Luxury runs, cover, CTA, previews), review page, brief template |

## 2. Data model — one source of truth

The **EditPlan** (`packages/core/src/schema/editplan.ts`) is the only input to rendering,
subtitle export, previews and QA. It is versioned (`plans/editplan-v###.json`) and never
mutated in place; revisions write a new version with `changes[]` and a parent pointer.

- **Time** is integer *flicks* (1/705,600,000 s): exact for every common frame and sample
  rate (60 fps frame = 11,760,000 flicks = 800 samples at 48 kHz). Intervals are half-open.
- **Segments** hold a frame-aligned picture interval and sample-aligned audio clips. Audio may
  lead picture (J-cut) but keeps the same recording-clock offset, so lip sync is an invariant
  checked by `validatePlan` (`sync.lip`). Separate mic audio uses an explicit `SourceClock`
  (offset + drift ppm).
- **TimeMap** pieces are derived from segments and stored for traceability; captions are
  retimed through it (never from raw transcript times).
- **Layout runs** tile `[0, END)` exactly; crop paths carry reasons, confidence and manual flags.
- **END** = the meaningful voice end rounded up to a whole output frame; every stem and layer
  shares it exactly.

## 3. Pipeline

```
ingest ─► transcribe ─► analyze ─────────► candidates ─► (questions) ─► brief ─► plan
 probe     whisper.cpp   scenes (scdet)      rubric score     preset, style,       EditPlan v1
 hash      word times    audio features      diversity/IoU    intensity            (validated)
 proxy     language      faces/tracks/gaze   evidence +
 audio     diarization   frame sheets ──► agent inspection notes (real visual evidence)
                                                                   │
   ┌───────────────────────────────────────────────────────────────┘
   ▼
 render ─► composite ─► export package ─► QA (frames/audio measured) ─► repair loop (≤ N passes)
  captions: HyperFrames state render (one frame per distinct caption state) → exact retiming
  graphics: HyperFrames run render (frame-by-frame, batched per clip, transparent where needed)
  footage:  FFmpeg trim/crop/scale per segment & layout run (static or planned crop paths)
  audio:    stems (voice/sfx/riser/music @48 kHz, END-length) → unity mix → measured master
```

### Rendering strategy (measured, see docs/COMPATIBILITY.md)

HyperFrames captures ~1–3 fps (caption state sheets) to ~4–7 fps (Luxury graphics) at
1080×1920 on the reference Intel Mac, so:

1. **Footage never goes through Chrome.** FFmpeg performs cuts, crops and scaling, which keeps
   it fast and bit-exact.
2. **Captions** render as a *state sheet*: one frame per distinct visual state (each chunk,
   each active word for karaoke styles, each entrance-animation frame). The compositor maps
   output frames → states from the EditPlan, producing a frame-exact RGBA overlay band.
3. **Graphics** render as one composition per Luxury layout run (exact run duration), cached by
   a hash of the generated HTML; the cover and CTA are their own small compositions. The world
   camera is sampled per frame in TypeScript (`core/luxury/camera.ts`) and written as timeline
   sets, so motion, blur and seeking are deterministic.
4. **Motion blur** for graphics: velocity-based directional blur inside the composition
   (σ = 0.29·v·(shutter/fps), capped), applied only to moving graphics layers, zero at rest;
   optional true sub-frame integration (240 fps render, explicit weights) for short windows.
5. All intermediates are tagged BT.709; overlays composite in YUV with explicit BT.709
   conversion; HDR (PQ/HLG) sources are tone mapped through a generated 3D LUT before any
   crop (docs/COLOR.md). Final delivery is H.264 High yuv420p + AAC 48 kHz.

### Luxury Tech

```
creator/clip plan ─► lines (take segments + sentences) ─► eye-contact evidence (CV head pose + agent gaze notes)
   ─► layout planner (core/luxury/layout.ts): hook→split, opinion/outro→camera, screen→visual, ≤8 s runs, no repeats
   ─► geometry: one held 9:16 crop; one split transform shared by card + head (face-derived, card covered)
   ─► graphics brief (director-authored, word-anchored) ─► compile (moves, actions, sounds, limits)
   ─► render: HyperFrames run compositions · source-span clip → remove-background matte (QA: IoU, alignment)
   ─► FFmpeg: graphics → card through rounded mask → head (matte × ramp: opaque to the card top, fades inside)
   ─► captions per run zone · synth music/SFX/riser from visible events · cover (frame 0) · CTA (if spoken/briefed)
```

## 4. Analysis honesty

- `analysisLevel` per candidate: `audiovisual-agent` (Claude inspected timestamped sheets and
  recorded observations), `audiovisual-cv` (deterministic CV/audio evidence only), or
  `transcript-only` (explicitly downgraded; no claims about reactions or visual jokes).
- Coverage records frames sampled, sheets inspected and limitations. Sampling is never called
  exhaustive viewing.

## 5. Adaptive director

`brief draft` turns intent + evidence + preset into `brief/<clip>/brief-v###.md` (DIRECTOR_BRIEF) and a machine-readable
`BriefConstraints` (rules with units/tolerances and sources). QA findings carry a `repair`
rule; the director updates only implicated rules, writes the next brief version and a change
log entry, and invalidates affected stages (stage keys hash their inputs). `repair` maps findings
to targeted plan changes (headroom, sound events, a run's caption zone, highlights, held crops),
re-renders from caches and re-checks. Repairs are bounded by passes and minutes; remaining hard
failures mark the render `draft`/`blocked`.

## 5b. Review and delivery

`review` writes a static `review/index.html` (candidates + evidence, caption A/B sheets, layout and
graphics previews, renders with QA and reports). `approve` marks finals (creator edits also get
`edit/final.mp4`); `export` packages MP4, preview, cover, subtitles, plan, stems, editable HyperFrames
sources and reports with a checksummed manifest. `scripts/package-plugin.ts` builds the clean
installable plugin + marketplace in `release/`.

## 6. Precedence

`user → project overrides → preset → brief → defaults` (`config/precedence.ts`). Overriding a
hard preset rule is a material conflict: Guided mode asks with AskUserQuestion; Autonomous
mode keeps the most explicit user intent and logs it.

## 7. Filesystem and runtime

- Plugin root is read-only. Runtime (venv, HyperFrames, Chrome, whisper.cpp, models) lives in
  `SHORTS_STUDIO_HOME` → `${CLAUDE_PLUGIN_DATA}` (passed by skills/hooks) → `<repo>/.runtime`
  (dev checkout) → `~/.shorts-studio`.
- Workspace (projects, caches, preferences) = `--workspace` / `SHORTS_STUDIO_WORKSPACE` / cwd.
  Projects live in `<workspace>/projects/<id>/`; acquisition/proxy caches are keyed by content
  hash under `<workspace>/.shorts-studio/cache/`.
- Stages persist atomic state (`state/stages/*.json`) keyed by input hashes: reruns are cached,
  Ctrl-C marks a stage cancelled, rerunning resumes.

## 8. Questions and agents

AskUserQuestion is only available in the main conversation (removed from subagents), so skills
ask; worker agents return uncertainties to the director. Workers have narrow contracts
(source analysis, graphics, audio, QA) and write to isolated directories.
