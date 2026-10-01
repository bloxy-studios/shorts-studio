---
name: quality-check
description: >-
  Internal — audiovisual QA of a rendered short. Runs measured checks (delivered spec, full decode, frame count, loudness and true peak after AAC, END-length stems, caption sync against the final voice track, caption bounds vs platform guides and faces, black/frozen frames, blank tail) and requires your inspection of the generated frame sheets before anything is called passed.
user-invocable: false
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/shorts-studio *) Bash(shorts-studio *) Read
license: MIT
compatibility: >-
  Needs the Shorts Studio engine (Claude Code plugin bloxy-studios/shorts-studio, or a clone of that repo) with Bun, Node >= 22 and FFmpeg; `shorts-studio doctor --setup` installs the rest project-locally.
metadata:
  internal: true
---

# Quality check (internal)

1. `render` already runs QA. To re-run: `shorts-studio qa <project> --clip <id> [--render rNNN]`.
2. Read `renders/<rid>/qa.json` findings and the sheets `qa/contact.jpg` (whole video incl.
   first/last frames) and `qa/cuts.jpg` (frames either side of every cut/layout join).
3. Inspect: framing (faces, headroom, the right person), captions (legible, not over faces/UI,
   emphasis meaningful, none stale), cut smoothness, colour, graphics landing frames, anything
   broken. Record it: `shorts-studio qa note <project> --clip <id> --render <rid> --what "..." --notes "..."`.
4. Each failing finding names a repair rule; apply it with `/shorts-studio:revise`, re-render,
   re-check. Stop after the project's repair budget and deliver honestly as draft/blocked.

Never say "QA passed" from an exit code alone. Full real-time playback is not possible here;
say so and point the user to `preview_540x960.mp4`.

Completion: `qa.json` verdict recorded, every sheet inspection recorded (`agent-visual`), and
remaining failures listed in the report.
