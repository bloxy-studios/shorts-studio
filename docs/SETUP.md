# Setup

Shorts Studio is a Claude Code plugin with a local engine. Nothing is installed system-wide:
no `sudo`, no global npm or pip packages. The runtime (Python venv, HyperFrames, pinned Chrome,
whisper.cpp, models) lives in one project-local directory.

## 1. Prerequisites (you install these)

| Tool | Version | Why |
| --- | --- | --- |
| Claude Code | current | hosts the plugin (skills, hooks) |
| Bun | ≥ 1.2 | runs the `shorts-studio` CLI |
| Node.js | ≥ 22 | HyperFrames renderer; yt-dlp's JS runtime for YouTube |
| FFmpeg + ffprobe | ≥ 6 with libx264 | all media work (`brew install ffmpeg`, or set `SS_FFMPEG_BIN`) |
| uv | current | creates the local Python 3.12 environment |
| git, cmake, a C++ toolchain | — | builds whisper.cpp locally (macOS: Xcode Command Line Tools) |

## 2. Install the plugin

From GitHub (the plugin marketplace is this repository; only committed files are installed, ~9 MB):

```text
/plugin marketplace add bloxy-studios/shorts-studio
/plugin install shorts-studio@shorts-studio
```

As Agent Skills for any supported agent (listed on skills.sh): `npx skills add bloxy-studios/shorts-studio`.
That copies skill folders only; the first skill you run checks for the engine and, with your OK,
installs it as the plugin or as a clone in `~/.shorts-studio/engine`.

From a local checkout, package a clean plugin first. Installing the checkout directory would copy its
runtime, projects and fixtures (gigabytes):

```bash
bun scripts/package-plugin.ts                 # → release/ (≈4 MB: plugin + its own marketplace), validated
claude plugin marketplace add ./release
claude plugin install shorts-studio@shorts-studio
```

For development, load it without installing: `claude --plugin-dir /path/to/shorts-studio`.

## 3. Install the runtime (once)

Inside Claude Code run `/shorts-studio:doctor`, or from a shell:

```bash
shorts-studio doctor            # read-only report: what is present, what is missing, how to fix it
shorts-studio doctor --setup    # project-local install: venv + packages, HyperFrames 0.8.97 + GSAP,
                                # chrome-headless-shell 152, whisper.cpp (built at a pinned commit), models
shorts-studio doctor --setup --models whisper-small   # optional multilingual model (Kiswahili / mixed)
```

Runtime location: `SHORTS_STUDIO_HOME`, else the plugin data directory (`CLAUDE_PLUGIN_DATA`),
else `<repo>/.runtime` for a development checkout, else `~/.shorts-studio`. The SessionStart hook
exports it for every session. HyperFrames' background-removal model (~176 MB) downloads on the
first Luxury Tech split render into `~/.cache/hyperframes/background-removal/`.

## 4. First run

```text
/shorts-studio:clip https://www.youtube.com/watch?v=… 3 clips, clean podcast style
/shorts-studio:creator-edit camera.mp4 mic.wav — use Luxury Tech and do everything yourself
```

Projects are created in the current workspace under `./projects/<id>` (override with `--workspace`).
Open `projects/<id>/review/index.html` (`shorts-studio review <id>`) to browse candidates, previews,
renders and QA.

## Privacy defaults

Processing is local. Sources are never uploaded, no paid service is enabled, and nothing is posted.
An export to a remote destination happens only when you name it and a connector is configured.
Telemetry is disabled for HyperFrames (`HYPERFRAMES_NO_TELEMETRY=1`).

## Uninstall

`claude plugin uninstall shorts-studio`, then delete the runtime directory shown by
`shorts-studio doctor` and any `./projects` you no longer need.
