# Shorts Studio CLI reference

Generated from the command registry by `bun scripts/gen-cli-reference.ts` — do not edit by hand.
Every command accepts `--json` (machine-readable result on stdout), `--quiet`, `--workspace DIR` and `--data-dir DIR`.
In skills the binary is `"${CLAUDE_PLUGIN_ROOT}/bin/shorts-studio"` (also on PATH as `shorts-studio`).

## `analyze`

Scenes, audio features, face tracks, timestamped frame sheets; `note` records agent observations

```
shorts-studio analyze <project> [--source ID] [--face-fps N] [--tiles N] [--force]
shorts-studio analyze note <project> --kind reaction|action|on-screen-text|screen-demo|gesture|laughter|scene|quality-issue|gaze|other --at TIME [--end TIME] --detail TEXT [--confidence 0-1] [--sheet ID] [--source ID]
```

## `approve`

Mark a render as the approved final for a clip (never overwritten by later revisions)

```
shorts-studio approve <project> --clip ID --render rNNN
```

## `brief`

Director brief: draft DIRECTOR_BRIEF + constraints from the plan and evidence, show it, or refine it from feedback

```
shorts-studio brief draft|show|refine <project> --clip ID [--goal TEXT] [--audience TEXT] [--instruction TEXT]... | refine: --feedback TEXT [--rule-id ID --area AREA --rule TEXT [--hard]] [--remove RULE_ID]...
```

## `candidates`

Rank standalone moments with evidence (build | preview | note | show)

```
shorts-studio candidates <project> [--source ID] [--count N] [--duration MIN-MAX]
shorts-studio candidates preview <project> [--top N]
shorts-studio candidates note <project> --id ID [--title T] [--hook H] [--why W] [--start TIME --end TIME] [--state selected|rejected|shortlisted --reason R] [--evidence TEXT --at TIME] [--editorial 0-1]
shorts-studio candidates show <project> --id ID
```

## `capture`

Capture a real web page (or local HTML file) as a PNG for a Luxury source-page visual, with provenance (URL, time, sha256)

```
shorts-studio capture <project> <url> [--name ID] [--width 1280] [--height 2400]
```

## `creator`

Creator Edit: camera + clean mic → aligned voice, selected takes, J-cuts, finished short (edit/final.mp4)

```
shorts-studio creator <project> --camera FILE --mic FILE [--preset ID] [--style ID] [--title TEXT] [--brief graphics.json] [--keyword TERM]... [--language en] [--render]
```

## `doctor`

Check dependencies, models, codecs, renderer; --setup installs the local runtime

```
shorts-studio doctor [--setup] [--models yunet,whisper-base.en,whisper-small.en,whisper-small,silero-vad] [--json]
```

## `export`

Package final clips (MP4, preview, cover, subtitles, plan, stems, sources, report) for delivery

```
shorts-studio export <project> [--clips clip-01,clip-02] [--approved-only] [--dest local:DIR | drive:FOLDER] [--stems] [--post-copy]
```

## `ingest`

Acquire/probe sources: local files, folders, manifests, YouTube URLs

```
shorts-studio ingest <project> <file|folder|manifest.json|url>... [--role primary|camera|mic|screen|broll] [--force]
```

## `luxury`

Luxury Tech: plan layout runs + graphics from a director brief, preview graphics frames, or write a brief template

```
shorts-studio luxury plan|preview|brief <project> --clip ID [--brief FILE] [--title TEXT] [--at SECONDS,...]
```

## `plan`

Build a validated EditPlan for a clip from a source range or candidate

```
shorts-studio plan <project> (--range START-END | --candidate ID) [--clip ID] [--preset ID] [--style ID] [--title TEXT] [--keyword TERM]... [--source ID] [--replan --reason TEXT]
```

## `prefs`

Preferences: list, add (explicit or tentative; --default only when the user says 'save this as my default'), or import a reference prompt/file

```
shorts-studio prefs list <project> | add <project> "TEXT" [--area AREA] [--tentative] [--default] | import <project> FILE [--name NAME]
```

## `preset`

Brand/design presets: list, show, or create a workspace preset or caption style from a base with validated overrides

```
shorts-studio preset list | show <id> [--captions] | create <new-id> --from <base> [--captions] [--name TEXT] [--set path=JSON]...
```

## `preview`

Visual style previews: `preview captions` renders one excerpt in every caption style + a comparison sheet

```
shorts-studio preview captions <project> --range START-END [--source ID] [--styles clean,bold-pop,...]
```

## `project`

Create, list or show projects (init <name> | list | show <project>)

```
shorts-studio project init <name> [--preset ID] [--mode guided|director|autonomous] [--platform P]... [--clips N] [--duration 30-60] [--language en|sw|auto] [--dir PATH]
shorts-studio project list
shorts-studio project show <project>
```

## `qa`

Re-run QA on a render, or record a visual inspection (`qa note`)

```
shorts-studio qa <project> --clip ID [--render rNNN]
shorts-studio qa note <project> --clip ID --render rNNN --what TEXT --notes TEXT [--how agent-visual|human|agent-audio-measure]
```

## `render`

Render a clip from its current EditPlan, then run measured QA and write the report

```
shorts-studio render <project> --clip ID [--draft] [--plan-version N] [--platform youtube-shorts|tiktok|instagram-reels|generic-9x16]
```

## `repair`

Bounded critique→refine→verify loop: targeted fixes for QA findings, re-render, re-check (budget from project config)

```
shorts-studio repair <project> --clip ID [--render ID] [--max-passes N] [--max-minutes M]
```

## `review`

Generate the local HTML review page (candidates + evidence, caption A/B sheets, layout/graphics previews, renders with QA and reports)

```
shorts-studio review <project>
```

## `revise`

Apply typed revisions (from natural-language feedback) as a new plan version

```
shorts-studio revise <project> --clip ID --reason "<the user's words>" --op '<json>' [--op '<json>' ...]
ops: {"op":"extend-end","ms":500} {"op":"trim-end","ms":300} {"op":"extend-start","ms":400} {"op":"trim-start","ms":200}
     {"op":"keep-both-visible","from":"0:01.3","to":"0:04.3","timebase":"output"} {"op":"switch-speaker","at":"0:12"}
     {"op":"reduce-motion"} {"op":"caption-style","styleId":"clean"} {"op":"caption-emphasis","keywords":["Claude Code"],"onlyKeywords":true}
     {"op":"music-gain","db":-2} {"op":"caption-zone","from":"0:05","to":"0:09","y0":365,"y1":634,"reason":"face covered"}
     {"op":"caption-correct","from":"Artemus","to":"Artemis","at":"0:12"} {"op":"voice-chain","denoise":"off","deess":true}
```

## `transcribe`

Local whisper.cpp transcription with word timings (language-aware)

```
shorts-studio transcribe <project> [--source ID] [--model base.en|small|...] [--language en|sw|auto] [--force]
```
