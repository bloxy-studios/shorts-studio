---
name: edit
description: >-
  General editing of supplied media into a short: pick a source range or candidate, trim and pace it on sentence boundaries, reframe, caption, add music/SFX and graphics per the chosen preset, render with QA. Routes camera + clean-mic recordings to Creator Edit.
when_to_use: >-
  "edit this clip", "make a short from 2:10 to 2:55", "tighten this", "add music and captions to my video"
argument-hint: "<file|project> [range] [preset] [instructions]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/shorts-studio *) Bash(shorts-studio *) Read
effort: medium
license: MIT
compatibility: >-
  Needs the Shorts Studio engine (Claude Code plugin bloxy-studios/shorts-studio, or a clone of that repo) with Bun, Node >= 22 and FFmpeg; `shorts-studio doctor --setup` installs the rest project-locally.
---

# Edit supplied media

Rules: `${CLAUDE_PLUGIN_ROOT}/references/rules.md` · CLI: `${CLAUDE_PLUGIN_ROOT}/references/cli.md`.
`ss` = `"${CLAUDE_PLUGIN_ROOT}/bin/shorts-studio"`. Input: `$ARGUMENTS`

## 0. Engine check

The commands below run the Shorts Studio engine. Installed as the Claude Code plugin it is already
present and `shorts-studio` is on the Bash PATH. If `shorts-studio doctor` is not found (for example,
this skill was added with `npx skills add`), ask the user before installing anything, then:
- Claude Code: `/plugin marketplace add bloxy-studios/shorts-studio` → `/plugin install shorts-studio@shorts-studio`.
- Other agents: `git clone --depth 1 https://github.com/bloxy-studios/shorts-studio ~/.shorts-studio/engine`
  and read every `${CLAUDE_PLUGIN_ROOT}` path below as `~/.shorts-studio/engine`.

Then run `shorts-studio doctor --setup` once (project-local runtime; never sudo or global installs).

## Steps

1. Separate camera + clean mic recording → `creator-edit` skill. A long video with "find the best parts" → `clip` skill.
2. Otherwise: `ss project init …` → `ss ingest <project> <file>` → `ss transcribe` → `ss analyze` (read the sheets).
3. Plan the range: `ss plan <project> --clip clip-01 --range 2:10-2:55` (boundaries snap to sentences:
   the end extends ≤ 3 s to finish a thought, the start moves ≤ 2 s back for setup; both are reported).
4. Render + inspect + revise: `ss render`, read `qa/contact.jpg`, then the `revise` skill for changes.
   Luxury Tech: continue with the `luxury-tech` skill after planning.
5. Export: `export` skill.

## Limits

One source range per clip (multi-range montage from different files is not supported yet — say so and
offer separate clips or a creator-style assembly when the files are takes of one recording).

## Completion check

The rendered clip starts and ends on complete thoughts (check the first/last captions), QA has no hard
failure, and the report records any boundary adjustment.
