---
name: graphics
description: >-
  Author and verify HyperFrames graphics for a short: white-card scenes, UI demonstrations (typing, click, streamed answer), checklists, stats, radar/tiles/icons, source-page captures, connectors, world-camera moves (glide, step, push, pull, one whip) with velocity motion blur, cover and CTA. Every graphic is a deterministic, seekable composition linted and snapshot-checked before rendering.
when_to_use: >-
  "add a graphic/visual for this part", "show the UI", "animate the typing", "make the visuals better", "use a source page for this claim"
argument-hint: "<project> --clip <id> [what to show]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/shorts-studio *) Bash(shorts-studio *) Read Write
effort: high
license: MIT
compatibility: >-
  Needs the Shorts Studio engine (Claude Code plugin bloxy-studios/shorts-studio, or a clone of that repo) with Bun, Node >= 22 and FFmpeg; `shorts-studio doctor --setup` installs the rest project-locally.
---

# Graphics (HyperFrames)

Rules: `${CLAUDE_PLUGIN_ROOT}/references/rules.md` · CLI: `${CLAUDE_PLUGIN_ROOT}/references/cli.md` ·
Luxury design system: `${CLAUDE_PLUGIN_ROOT}/presets/luxury-tech/DESIGN.md`.
`ss` = `"${CLAUDE_PLUGIN_ROOT}/bin/shorts-studio"`. Input: `$ARGUMENTS`

Graphics runs are planned by the Luxury Tech layout (split / full visual). Specs live in
`clips/<clip>/luxury/graphics.json` (`ss luxury brief` writes a template listing each line's words).

## 0. Engine check

The commands below run the Shorts Studio engine. Installed as the Claude Code plugin it is already
present and `shorts-studio` is on the Bash PATH. If `shorts-studio doctor` is not found (for example,
this skill was added with `npx skills add`), ask the user before installing anything, then:
- Claude Code: `/plugin marketplace add bloxy-studios/shorts-studio` → `/plugin install shorts-studio@shorts-studio`.
- Other agents: `git clone --depth 1 https://github.com/bloxy-studios/shorts-studio ~/.shorts-studio/engine`
  and read every `${CLAUDE_PLUGIN_ROOT}` path below as `~/.shorts-studio/engine`.

Then run `shorts-studio doctor --setup` once (project-local runtime; never sudo or global installs).

## Authoring a run spec

- `items[]` (world px; at rest the camera shows world = canvas): `card` (eyebrow/title/body/icon),
  `stat`, `list` (rows with `check`/`cross` marks timed by `markAt`), `tile` (icon + label),
  `chat` (app window: `typeAt` → `sendAt` → `responseAt`), `code`, `document` (+ `stamp`),
  `image` (local capture; media radius 3 % of width), `radar`, `text`, `connector` (`from` → `to`).
  Icons: run `ss luxury brief` and read `$icons` (original line icons; unknown names fail loudly).
- Timing is word-anchored: `{"word": "cars"}` (+ `nth`, `lead`) or `{"at": 1.2}` seconds into the run.
- `camera[]`: `step` (0.5 s power3.inOut, 0.25 s before its word), `push` (1.2–2 s, ≤ 1.6×),
  `pull`, `whip` (0.45 s + 0.6 s; midpoint on the word; ≤ 1 per run). `start` frames the first subject.
- `focus` (depth of field: neighbours ≤ 14 px blur/70 %, previous hero 9 px/40 %), `innerZoom`
  (1.15–1.4×, 0.4–0.7 s inside a held window), `clicks`.
- Claims, figures, headlines: capture the real supporting page —
  `ss capture <project> <url> --name <id>` (pinned headless Chrome; provenance JSON beside the PNG) — and show it
  as `{"kind":"source-page","src":"<png>","label":"Source: …","pan":[{"when":{"word":"…"},"y":0.4,"scale":1.15}]}`
  (fixed frame x 24, y 200, 1032×1040, r 36 over a washed blurred clone; the capture pans inside) with
  `sources: [{url, kind: "capture", disclosed: true}]`. Check substantive numbers against two independent
  sources where they exist (two sites repeating one announcement are not independent). A reconstruction is
  `kind: "reconstruction"` and disclosed. Never invent capabilities or an "official" screenshot.

## Verify (always, before a full render)

1. `ss luxury plan <project> --clip <id>` — fix every warning (unknown word, zone overflow, > 2 subjects, overlapping moves).
2. `ss luxury preview <project> --clip <id>` — read each run's contact sheet: sharp landing frame,
   readable text (nothing designed below 30 px), hierarchy, clear of the caption zone.
3. After `ss render`, read real frames around every move/event; QA `luxury.landing-sharp` must pass.

## Limits

- Motion blur: directional Gaussian from the analytic camera velocity (σ = 0.29 × speed × 0.75/60,
  ≤ 40 px) on the world layer only; footage, captions and page text are never blurred.
- The renderer captures ~4 frames/s at 1080×1920 here; long full-visual runs take minutes (cached by content).
- Non-Luxury presets currently use footage layouts only (no graphics runs).

## Example

"Show the radar becoming the car autopilot": `radar` item + `tile` car + `connector`; `camera`: whip to the
car on "autonomous" → re-plan → preview → render.

## Completion check

Every graphics run is director-authored (no "(auto)" in the layout table) or the auto card is reported;
previews were read; `luxury.landing-sharp` and `luxury.sfx-rules` pass on the render.
