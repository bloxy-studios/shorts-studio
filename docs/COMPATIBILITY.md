# Compatibility record

Verified on the reference machine on 2026-10-01. Everything below was measured or exercised
by the commands in `docs/VALIDATION.md`; nothing is assumed from documentation alone.

## Reference machine

| Item | Value |
| --- | --- |
| OS | macOS 26.5.1 (build 25F80, Darwin 25.5.0) |
| CPU / RAM | Intel Core i5-7300U @ 2.60 GHz (x86_64, 2 cores / 4 threads), 8 GB |
| GPU acceleration | none used (CPU paths only) |

## Toolchain (pinned or project-local)

| Component | Version | Where | Notes |
| --- | --- | --- | --- |
| Claude Code | `~/.local/bin/claude` (plugin validate + details) | user install | `claude plugin validate --strict` passes; 20 skills load |
| Bun | 1.4.0 | user install | orchestration CLI (`bin/shorts-studio`) |
| TypeScript | 7.0.2 (dev) | `node_modules` | `tsc --noEmit` strict |
| Node.js | 26.7.0 | `/usr/local/bin/node` | HyperFrames runtime + yt-dlp JS runtime (`--js-runtimes node:<path>`) |
| HyperFrames | 0.8.97 (Apache-2.0) | `<runtime>/node` | pinned; never `latest` in production |
| GSAP | 3.14.2 (GreenSock standard no-charge licence) | `<runtime>/node` | copied into each composition |
| Chrome headless shell | 152.0.7977.30 | `<runtime>/browsers` | pinned via `HYPERFRAMES_BROWSER_PATH` |
| FFmpeg / ffprobe | 8.1.2 | `/usr/local/bin` | no libzimg (`zscale`): HDR uses the LUT path (docs/COLOR.md) |
| whisper.cpp | 1.9.4, commit `6e4ab854f67f743900934a703d5603419384c961` | `<runtime>/bin/whisper-cli` | built locally by `doctor --setup` |
| Python | 3.12.13 | `<runtime>/venv` | numpy 2.5.3, scipy 1.18.1, opencv 4.14.0, pillow 12.3.0, soundfile 0.14.0, fonttools 4.66.1, pyloudnorm, pytest |
| yt-dlp | 2026.08.19 | `<runtime>/venv` | local self-update allowed once on an outdated-extractor error |

`<runtime>` = `SHORTS_STUDIO_HOME` → `CLAUDE_PLUGIN_DATA` → `<repo>/.runtime` (dev checkout) → `~/.shorts-studio`.

## Models

| Model | File | Licence | Use |
| --- | --- | --- | --- |
| Whisper base.en | `whisper/ggml-base.en.bin` | MIT | English transcription (default) |
| Whisper small (multilingual) | `whisper/ggml-small.bin` | MIT | Kiswahili / mixed-language path |
| Silero VAD v6.2.0 | `whisper/ggml-silero-v6.2.0.bin` (sha256 `2aa269b7…`) | MIT | optional; our own energy VAD drives chunking |
| YuNet 2023mar | `cv/face_detection_yunet_2023mar.onnx` (sha256 `8f2383e4…`) | MIT | face detection / landmarks |
| U²-Net human segmentation | `~/.cache/hyperframes/background-removal/models/u2net_human_seg.onnx` (176 MB) | Apache-2.0 | HyperFrames `remove-background` (head matte) |

## Measured capabilities and limits

| Capability | Result on this machine |
| --- | --- |
| HyperFrames graphics capture | 1080×1920: ~4.4 fps (first test), 5–7 fps on Luxury runs; caption state sheets ~1–3 fps |
| `hyperframes render --fps` | accepts 1–240 (240 fps sub-frame renders verified) |
| Motion blur flag | none in the CLI → velocity blur is generated per frame in the composition; 240→60 integration available |
| `hyperframes remove-background` | exists in 0.8.97; providers: CPU only (no CoreML on this Intel Mac); 1.6 s/frame at 1280×720; output ProRes 4444 `yuva444p12le`, same frame count as the input |
| Snapshot timing | `hyperframes snapshot` quantizes `--at` to the composition fps (set `data-fps`) |
| HyperFrames transients | first FFmpeg preflight can time out at 5 s on this machine → one automatic retry |
| Low-memory mode | auto-enables at 8 GB RAM (1 worker, screenshot capture) |
| Colour | HyperFrames MP4s are tagged BT.709 TV range; flat colours land within 1–3 code values of the CSS value |
| FFmpeg `overlay=format=auto` with an RGBA overlay | round-trips the whole frame through RGB (BT.601) and shifts flat colours by ~3 levels → all overlays run in YUV with explicit BT.709 conversion |
| whisper.cpp `--vad` | token offsets stay on the VAD-compressed timeline → disabled; our VAD-chunked transcription with coverage verification instead |
| whisper.cpp DTW (`--dtw`) | needs `-nfa` (flash attention off); timestamps lag ~0.25–0.3 s on base.en → not used |
| whisper.cpp chunk ends | last words can drift up to ~0.8 s late (even past the audio) → re-timed inside the measured speech end (`time-adjusted`) |
| YouTube | needs a JS runtime for signatures; subtitles fetched best-effort (HTTP 429 must not fail the download) |

## Not verified here

- Apple Silicon (CoreML background removal would likely be faster), Linux and Windows hosts.
- Google Drive upload: the destination adapter refuses without a configured connector (none in this session).
- Hosted AI providers: intentionally not enabled (local-only by the user's choice).
