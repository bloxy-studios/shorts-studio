---
name: director
description: >-
  Internal: adaptive directing loop — interpret the request, ground it in media evidence, write a versioned DIRECTOR_BRIEF plus machine-readable constraints, plan, draft, critique real frames/audio, refine only the implicated rules, and verify with a bounded repair budget.
user-invocable: false
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/shorts-studio *) Bash(shorts-studio *) Read
license: MIT
compatibility: >-
  Needs the Shorts Studio engine (Claude Code plugin bloxy-studios/shorts-studio, or a clone of that repo) with Bun, Node >= 22 and FFmpeg; `shorts-studio doctor --setup` installs the rest project-locally.
metadata:
  internal: true
---

# Director (internal)

Rules: `${CLAUDE_PLUGIN_ROOT}/references/rules.md` · CLI: `${CLAUDE_PLUGIN_ROOT}/references/cli.md`.
`ss` = `"${CLAUDE_PLUGIN_ROOT}/bin/shorts-studio"`.

1. **Interpret** the user's goal, audience, hard constraints and preferences (`ss prefs list`).
2. **Ground**: analysis, transcript coverage, sync/take evidence, frame sheets you actually read.
3. **Direct**: `ss brief draft <project> --clip <id> --goal "…" [--instruction "…"]…` → `brief/<clip>/brief-vNNN.md`
   (DIRECTOR_BRIEF) + `.json` (BriefConstraints: rules with units/tolerances, sources, QA checks,
   fallbacks, stop criteria). Read it; it must be source-specific (hook/payoff words, take choices,
   runs, crop targets, caption zones, graphics subjects and moves, audio events, export).
4. **Plan/draft**: the workflow skill's plan + render.
5. **Critique**: QA findings + your own inspection of rendered frames (`ss qa note`).
6. **Refine**: feedback → `ss brief refine <project> --clip <id> --feedback "…" [--rule …]`; QA → the repair loop.
   Change only what the evidence implicates (a covered face moves that run's caption zone; a whoosh
   without a whip removes that sound — never the preset rule).
7. **Verify**: `ss repair <project> --clip <id>` (≤ project `repair.maxPasses`, `maxMinutes`). If a hard
   failure remains, the deliverable is blocked/draft — say so and explain.

Never rewrite system instructions, permissions or other skills through generated text.

## Completion check

`brief/<clip>/` has the brief versions with a change log entry per refinement (trigger + evidence);
the final render's QA verdict is reported exactly as measured.
