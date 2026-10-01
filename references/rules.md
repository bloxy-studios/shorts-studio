# Shorts Studio — shared operating rules

Every Shorts Studio skill follows these rules. Skills link here instead of repeating them.

## Running the engine

- The CLI is `"${CLAUDE_PLUGIN_ROOT}/bin/shorts-studio"` (skills show the substituted absolute
  path; it is also on the Bash PATH as `shorts-studio`). Add `--json` when you need to parse
  results. Long commands print stage progress on stderr; let them finish.
- If a command reports a missing runtime piece, run `shorts-studio doctor`; if it is missing,
  run `shorts-studio doctor --setup` (project-local install: no sudo, no global npm/pip) and
  tell the user what was installed. Never install system-wide.
- Projects live in the user's workspace (`./projects/<id>`), never inside the plugin folder.

## Modes

| Mode | When | Behaviour |
| --- | --- | --- |
| Guided (default) | No mode given | Ask a small batch of consequential questions, analyze, show candidates and visual style previews, then produce the chosen edit. |
| Director | "show me your plan first", "let me steer" | Show recommended choices and one representative draft; render the batch after the user steers. |
| Autonomous | User explicitly says to do everything / work autonomously | Choose reasonable defaults, never ask creative questions, record every decision and fallback in the report. |

Record the mode with `shorts-studio project init ... --mode` and every answer as a decision so
it is never asked twice in the same project.

## Questions (AskUserQuestion)

- Use the real `AskUserQuestion` tool — never print a fake JSON question.
- Ask only for missing information that changes the result. Batch 2–3 questions per call
  (hard limits: 1–4 questions, 2–4 options, header ≤ 12 characters, unique labels).
- Put the recommended option first with "(Recommended)" in its label; descriptions say what
  happens. The tool adds "Other" automatically for custom answers.
- Show visual previews (caption sheets, layout frames) *before* asking the user to choose
  between unfamiliar style names; use the option `preview` field for short text mockups.
- Follow explicit answers even when they differ from your recommendation.
- Questions stay in the main conversation. Worker agents return uncertainties to you; they
  cannot ask the user (the tool is unavailable in subagents).
- If AskUserQuestion is unavailable (e.g. non-interactive `-p` run), say so once and use
  explicit configuration or documented defaults.

Typical first batch: output platform, clip count / duration band, editing preset, interaction
mode. Technical details (codecs, models, thresholds) are yours to decide unless they change
cost, compatibility or data handling.

## Precedence

Current explicit user instructions → chosen preset + saved project overrides → generated
directing brief → renderer defaults. Detect conflicts before rendering. A conflict with a
*hard* preset rule (e.g. "zoom in on me" under Luxury Tech, which forbids footage motion) is
material: in Guided mode ask; in Autonomous mode keep the most explicit user intent, use a
valid technique, and log it.

## Directing loop (brief → draft → critique → refine → verify)

1. `shorts-studio brief draft <project> --clip <id> --goal "…"` writes a versioned DIRECTOR_BRIEF
   (`brief/<clip>/brief-vNNN.md`) and its constraint set (`.json`) from the request, preset,
   preferences, evidence and plan. Read it before rendering; it must be source-specific.
2. Render a draft or the final; read the QA sheets and real frames; record inspections.
3. User feedback → `shorts-studio brief refine … --feedback "…"` (+ the matching `revise` ops).
   QA findings → `shorts-studio repair <project> --clip <id>`: targeted fixes only (a covered face
   moves that run's caption zone; a whoosh without a whip removes that sound, not the rule),
   bounded by `repair.maxPasses`/`maxMinutes` in `project.json`.
4. If a hard failure remains, the deliverable is blocked/draft. Say so; never call it a pass.

## Honesty

- Do not treat a page description, title or transcript as having watched the video. Visual
  claims (reactions, gestures, on-screen text) require inspecting frame sheets (Read the
  sheet images) and recording observations with `shorts-studio analyze note`.
- Report coverage honestly: sampled frames are not frame-by-frame viewing. If only the
  transcript was analyzed, say the result is transcript-only.
- Never fabricate timestamps, downloads, measurements, official screenshots, or product
  capabilities. Disclose reconstructed UI. Separate verified facts from interpretation.
- "QA passed" requires the measured checks in `qa.json` plus your inspection of the QA frame
  sheets — never just an FFmpeg exit code. Report failures plainly.
- Scores are *editorial potential*, never "virality" predictions. Post copy must be honest.

## Data handling and permissions

- Local processing by default. Do not upload source footage, enable paid services, or publish
  posts without an explicit instruction. A request naming an upload destination authorizes
  that upload only.
- Do not repeatedly probe credentials or bypass access restrictions. If a source needs
  sign-in, ask for an authorized local copy.
- Persist preferences only when the user says so ("save this as my default"); otherwise keep
  them tentative for the current project.

## Files to know

- `ARCHITECTURE.md`, `docs/ENGINEERING.md` — how the engine works.
- `references/cli.md` — command reference.
- `references/workflows.md` — end-to-end recipes per skill.
- `presets/editorial/*.json`, `presets/captions/*.json` — machine-readable styles.
