---
name: ingest
description: >-
  Internal — resolve and acquire sources (YouTube URL variants, playlists, local files, folders, project manifests), verify real media bytes decode, probe duration/resolution/rotation/VFR/HDR/audio, hash for caching, and derive analysis proxies plus sample-aligned audio tracks. Used by clip, creator-edit and edit workflows.
user-invocable: false
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/shorts-studio *) Bash(shorts-studio *)
metadata:
  internal: true
license: MIT
compatibility: >-
  Needs the Shorts Studio engine (Claude Code plugin bloxy-studios/shorts-studio, or a clone of that repo) with Bun, Node >= 22 and FFmpeg; `shorts-studio doctor --setup` installs the rest project-locally.
---

# Ingest (internal)

`shorts-studio ingest <project> <url|file|folder|manifest.json>... [--role primary|camera|mic|screen|broll]`

- YouTube: single videos only; a playlist URL stops with a list request. `t=`/`start=` is
  recorded as a hint, never a trim. Subtitles are optional hints and never count as watching.
- Failures are diagnosed (missing dependency, outdated extractor → one local yt-dlp update,
  rate limit/network → one delayed retry, sign-in/private/geo/unavailable → stop and ask for
  an authorized local copy). Details: `projects/<id>/state/acquisition-failure.json`.
- Re-ingesting identical bytes is a cache hit (content hash). Originals are hard-linked into
  the workspace cache when possible, never copied into the plugin folder.
- Creator edits: ingest the camera with `--role camera` and the clean mic with `--role mic`.

Completion: `projects/<id>/sources/<src-id>/source.json` exists with `acquisition.status`
`acquired`/`local`, a probe, and derived `audio16k`, `audio48k` (and `analysisProxy` for video).
