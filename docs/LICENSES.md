# Licences and attribution

Shorts Studio's own code is MIT (see `.claude-plugin/plugin.json`). Third-party material:

## Bundled in this repository

| Asset | Licence | File |
| --- | --- | --- |
| Poppins (Indian Type Foundry) | SIL Open Font License 1.1 | `assets/fonts/OFL-Poppins.txt` |
| Instrument Serif (Instrument) | SIL Open Font License 1.1 | `assets/fonts/OFL-InstrumentSerif.txt` |
| Inter (Rasmus Andersson) | SIL Open Font License 1.1 | `assets/fonts/OFL-Inter.txt` |
| Anton (Vernon Adams) | SIL Open Font License 1.1 | `assets/fonts/OFL-Anton.txt` |
| Fredoka (Milena Brandão) | SIL Open Font License 1.1 | `assets/fonts/OFL-Fredoka.txt` |
| Line icons (`luxury-icons.ts`) | original work, MIT with this project | — |

Fonts are copied into each HyperFrames composition so exported compositions stay editable;
the OFL permits bundling and redistribution with the licence text.

## Installed into the local runtime (not bundled)

| Component | Licence |
| --- | --- |
| HyperFrames 0.8.97 | Apache-2.0 |
| GSAP 3.14.2 | GreenSock Standard "no charge" licence (https://gsap.com/standard-license) |
| Chrome headless shell 152 | Chromium BSD-style licences |
| whisper.cpp | MIT |
| Whisper ggml models (base.en, small) | MIT (OpenAI Whisper weights) |
| Silero VAD | MIT |
| YuNet face detector (OpenCV Zoo) | MIT |
| U²-Net human segmentation (via HyperFrames) | Apache-2.0 |
| yt-dlp | Unlicense |
| NumPy, SciPy, Pillow, OpenCV, soundfile, fontTools, pyloudnorm | BSD/MIT-style |
| FFmpeg | LGPL/GPL depending on the build you install (user-provided) |

## Audio

All music, SFX and risers are synthesized in code at render time (no samples, no stock audio).
Their output is part of your project.

## Test footage

`tests/fixtures/downloaded/nasa-artemis-soundbites.mp4` and the YouTube example are NASA media.
NASA content is generally not subject to copyright in the United States; NASA's media usage
guidelines apply (no implied endorsement; NASA insignia and logos are protected and are not
used in our graphics). Synthetic voices in `creator-takes` come from macOS `say` and are used
only as local test fixtures.
