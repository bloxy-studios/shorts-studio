---
name: analyze
description: >-
  Real audiovisual analysis of a source video — transcript coverage, speech activity, pauses, audio events, scene cuts, persistent face tracks with head-orientation and mouth-activity evidence, speaker↔face links, and timestamped frame sheets that you inspect and annotate. Produces evidence and ranked moment candidates. Use when the user wants to understand a video's strongest moments or before any clip selection.
when_to_use: >-
  "what are the best moments in this video", "analyze this podcast", "find the funny parts", "where does the demo happen"
argument-hint: "<project | youtube-url | file>"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/shorts-studio *) Bash(shorts-studio *) Read
license: MIT
compatibility: >-
  Needs the Shorts Studio engine (Claude Code plugin bloxy-studios/shorts-studio, or a clone of that repo) with Bun, Node >= 22 and FFmpeg; `shorts-studio doctor --setup` installs the rest project-locally.
---

# Analyze

Rules: `${CLAUDE_PLUGIN_ROOT}/references/rules.md`. CLI: `"${CLAUDE_PLUGIN_ROOT}/bin/shorts-studio"`.

## 0. Engine check

The commands below run the Shorts Studio engine. Installed as the Claude Code plugin it is already
present and `shorts-studio` is on the Bash PATH. If `shorts-studio doctor` is not found (for example,
this skill was added with `npx skills add`), ask the user before installing anything, then:
- Claude Code: `/plugin marketplace add bloxy-studios/shorts-studio` → `/plugin install shorts-studio@shorts-studio`.
- Other agents: `git clone --depth 1 https://github.com/bloxy-studios/shorts-studio ~/.shorts-studio/engine`
  and read every `${CLAUDE_PLUGIN_ROOT}` path below as `~/.shorts-studio/engine`.

Then run `shorts-studio doctor --setup` once (project-local runtime; never sudo or global installs).

## Steps

1. Ensure the source is ingested and transcribed (`ingest`, `transcribe`; see the clip skill).
2. `shorts-studio analyze <project>` — prints coverage, scenes, face tracks, and sheet paths.
3. Inspect every overview sheet image with Read. Increase density where something happens:
   `shorts-studio analyze <project> --tiles 48` (more frames) and candidate previews. Record
   each real visual observation with `shorts-studio analyze note <project> --kind <kind> --at <time> --detail "<what you saw>" --confidence <0-1> --sheet <id>`.
   Kinds: reaction, action, on-screen-text, screen-demo, gesture, laughter, scene, quality-issue, gaze.
4. `shorts-studio candidates <project> --count N --duration A-B` and
   `shorts-studio candidates preview <project> --top N`; read the previews; refine with
   `candidates note` (truthful titles/hooks, boundaries, reject weak ones).
5. Summarize for the user: ranked moments with times, why each holds, evidence type
   (transcript / audio / visual-cv / visual-agent), confidence, and coverage limitations.

## Honesty

- `analysisLevel` is `audiovisual-agent` only where you recorded observations; `audiovisual-cv`
  for deterministic CV/audio evidence; `transcript-only` when there is no usable picture —
  then say reactions and visual jokes are unverified.
- Sampled frames are not frame-by-frame viewing. Say how many frames were inspected.

## Completion check

`analysis/<source>/coverage.json` exists with transcript `full`, audio `full`, and visual
`agent-inspected` (or you stated why it is `cv-only`/`none`), and `analysis/candidates.json`
lists ranked candidates with evidence.
