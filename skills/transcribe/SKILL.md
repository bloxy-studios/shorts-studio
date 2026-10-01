---
name: transcribe
description: >-
  Internal — local whisper.cpp transcription with word timings on the source clock, VAD-chunked so silences never shift timestamps, with automatic coverage verification against measured speech (re-transcribes gaps, flags words outside speech). Language-aware (English models for English, multilingual for Kiswahili / mixed speech; never translates). Feeds captions, candidates and creator edits.
user-invocable: false
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/shorts-studio *) Bash(shorts-studio *)
license: MIT
compatibility: >-
  Needs the Shorts Studio engine (Claude Code plugin bloxy-studios/shorts-studio, or a clone of that repo) with Bun, Node >= 22 and FFmpeg; `shorts-studio doctor --setup` installs the rest project-locally.
metadata:
  internal: true
---

# Transcribe (internal)

`shorts-studio transcribe <project> [--source ID] [--model base.en|small.en|small] [--language en|sw|auto] [--force]`

- Model choice: explicit `--model` wins; English uses small.en/base.en; other or unknown
  languages use the multilingual model. English-only models are never used for non-English.
- Output: `analysis/<source>/transcript.json` (words with confidence and flags, segments,
  engine/version/model, notes incl. coverage %). Low-confidence and outside-speech words are
  flagged `uncertain` — captions show them as transcribed and the report lists them for review.
- Speaker diarization is not part of this step; speaker↔face association comes from analyze.

Completion: transcript notes report coverage ≥ 98% of measured speech, or you report the
uncovered regions and their effect on captions/candidates.
