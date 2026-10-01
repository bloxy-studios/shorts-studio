# Shorts Studio

[![skills.sh](https://skills.sh/b/bloxy-studios/shorts-studio)](https://skills.sh/bloxy-studios/shorts-studio)

A Claude Code plugin that turns YouTube links and local recordings into polished 9:16 shorts,
with a deterministic local engine behind Claude's directing:

- **Clip** long videos into ranked, standalone moments using transcript, audio and frame evidence.
- **Creator Edit**: from a camera file plus a clean mic WAV, it verifies sync, picks the last good take,
  removes false starts, and builds J-cut joins.
- **Luxury Tech** preset: a white-card world where camera footage never moves. It has three layouts,
  with the head breaking out of a camera card; word-anchored HyperFrames graphics with world-camera
  moves and motion blur; and code-synthesized music and SFX at 60 fps.
- Speaker-aware **reframing**, designed **captions** with caption previews, natural-language
  **revisions**, measured **QA**, an adaptive **director brief** with a bounded repair loop, and
  **exports** with stems and reports.

Everything runs locally by default. Nothing is uploaded or posted unless you ask.

## Install

**Claude Code plugin (recommended — includes the engine):**

```text
/plugin marketplace add bloxy-studios/shorts-studio
/plugin install shorts-studio@shorts-studio
```

Then let `/shorts-studio:doctor` (or `shorts-studio doctor --setup`) install the project-local runtime:
Python venv, HyperFrames, pinned Chrome, whisper.cpp and models. Nothing is installed with sudo or globally.
Prerequisites (Bun, Node ≥ 22, FFmpeg, uv, cmake) and details: [docs/SETUP.md](docs/SETUP.md).

**Agent Skills / [skills.sh](https://skills.sh/bloxy-studios/shorts-studio) (Claude Code, Codex, Cursor, …):**

```bash
npx skills add bloxy-studios/shorts-studio            # pick skills interactively
npx skills add bloxy-studios/shorts-studio --list     # list the skills
npx skills add bloxy-studios/shorts-studio --skill clip --skill creator-edit -a claude-code
```

This copies the skill folders only. On first use, each skill checks for the engine (`shorts-studio`). If it's
missing, the skill asks before installing it as the plugin or as a clone in `~/.shorts-studio/engine`.

**From a local checkout:** run `bun scripts/package-plugin.ts`, then `claude plugin marketplace add ./release`
(a clean ~4 MB package; installing the checkout itself would copy its runtime and projects).

## Use

```text
/shorts-studio:clip https://www.youtube.com/watch?v=… — 3 clips, 30–60 s, clean podcast style
/shorts-studio:creator-edit camera.mp4 mic.wav — use Luxury Tech, title it from the hook, do everything yourself
/shorts-studio:revise give the punchline another half second and make the music quieter
/shorts-studio:export
```

`/shorts-studio:studio` routes any request to the right workflow. Guided mode asks a few
consequential questions with real choices, showing caption sheets before asking. Director mode shows
the plan first. Autonomous mode logs every decision.

| Skill | What it does |
| --- | --- |
| `studio` | Router: intent, mode, project state |
| `clip` | Long video → ranked candidates → selected shorts |
| `analyze` | Real audiovisual analysis, frame sheets you inspect, ranked moments |
| `creator-edit` | Camera + clean mic → sync, takes, J-cuts, finished short (`edit/final.mp4`) |
| `luxury-tech` | The white-card, static-footage preset (layouts, matte, graphics brief, cover, CTA) |
| `graphics` | HyperFrames scenes: UI demos, lists, stats, radar/tiles, source captures, world camera |
| `captions` | Word-timed captions, designs, emphasis, corrections, SRT/VTT/words.json |
| `reframe` | Speaker-aware vertical framing, two-shots and stacks, calmer motion |
| `audio` | Voice cleanup, synthesized music/SFX/riser, stems, loudness and true peak |
| `preview` | Caption A/B sheets, candidate previews, graphics snapshots, drafts |
| `revise` | Natural-language changes become typed plan ops in a new plan version |
| `export` | Packages with MP4, preview, cover, subtitles, plan, stems, HyperFrames sources, reports |
| `design` / `style-learning` | Brand presets; reference prompts → rules; `PREFERENCES.md` |
| `doctor` | Dependency, model, codec and renderer checks; `--setup` |
| `ingest`, `transcribe`, `quality-check`, `director` | Internal support skills |

## How it works

One versioned **EditPlan** per clip is the single source of truth. It holds integer-flick time, an
explicit source↔output time map, layout runs, crop paths, captions, graphics, an audio event plan,
the cover and the CTA.

The Bun/TypeScript CLI (`bin/shorts-studio`) plans and validates, and Python helpers measure: VAD,
sync, loudness, faces, sheets, mattes and synthesis. FFmpeg renders all footage; HyperFrames renders
only designed layers (captions, graphics, cover, CTA). Every render runs measured QA and writes
`qa.json`, `report.md` and inspection sheets. `shorts-studio review <project>` builds a local HTML
review page.

Details: [ARCHITECTURE.md](ARCHITECTURE.md), [docs/ENGINEERING.md](docs/ENGINEERING.md),
[references/cli.md](references/cli.md), [presets/luxury-tech/DESIGN.md](presets/luxury-tech/DESIGN.md).

## Evidence

[docs/VALIDATION.md](docs/VALIDATION.md) records what was run and measured: tests, the end-to-end
YouTube clip, Creator Edit sync and takes against ground truth, Luxury Tech QA, motion blur on a moving
test edge, and HDR tone mapping. [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) lists the exact
toolchain, and [examples/](examples/) holds outputs from the demo projects.

## Limits (honest)

- Visual "watching" means sampled frame sheets plus CV. It is not real-time viewing.
- whisper.cpp word timing is typically within 20–80 ms but can drift at chunk ends. Those words are
  re-timed and flagged, and QA reports any remaining misses.
- Background removal runs on CPU here (~1.6 s per source frame), so only Luxury split runs are matted.
- 30 fps footage delivered at 60 fps repeats frames; only the graphics have genuine 60 fps motion.
- Google Drive export needs a configured connector; none is assumed.
