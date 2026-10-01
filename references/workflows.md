# Workflows (end-to-end recipes)

`ss` = `"${CLAUDE_PLUGIN_ROOT}/bin/shorts-studio"`. Every step writes versioned artifacts in
`projects/<id>/`; `ss review <id>` renders the review page at any point.

## Clip a long video into shorts (`clip` skill)

```bash
ss project init "<name>" --preset clean-podcast --mode guided --clips 3 --duration 30-60
ss ingest <p> "<youtube-url | file | folder>"
ss transcribe <p>                       # VAD-chunked whisper.cpp; coverage verified
ss analyze <p>                          # scenes, audio events, faces, frame sheets → READ the sheets
ss analyze note <p> --kind reaction --at 01:23.4 --detail "…"   # what you actually saw
ss candidates <p> --count 3 --duration 30-60 && ss candidates preview <p> --top 5   # READ previews
ss candidates note <p> --id c-002 --state selected
ss preview captions <p> --range 0:23.3-0:30.2   # READ caption-styles.jpg, then AskUserQuestion
ss plan <p> --candidate c-002 --clip clip-01 --style word-highlight
ss render <p> --clip clip-01            # QA + report; READ qa/contact.jpg, qa/cuts.jpg; ss qa note …
ss revise <p> --clip clip-01 --reason "…" --op '{…}' && ss render <p> --clip clip-01
ss approve <p> --clip clip-01 --render r002 && ss export <p> --approved-only
```

## Creator Edit (+ Luxury Tech)

```bash
ss project init "<name>" --preset luxury-tech --mode autonomous
ss creator <p> --camera camera.mp4 --mic mic.wav --preset luxury-tech     # sync, takes, assembly, layout
#  read creator-report.md; record gaze observations from the analysis sheets
ss luxury brief <p> --clip creator-edit            # template listing each line's words
#  write luxury/graphics.json (intents, title, runs: items, camera, actions)
ss luxury plan <p> --clip creator-edit             # layout-runs table; fix warnings
ss luxury preview <p> --clip creator-edit          # READ each run's contact sheet
ss render <p> --clip creator-edit                  # graphics, mattes, captions, synth audio, 60 fps, QA
ss brief draft <p> --clip creator-edit --goal "…"  # DIRECTOR_BRIEF + constraints
ss repair <p> --clip creator-edit                  # bounded targeted fixes for QA findings
ss approve <p> --clip creator-edit --render rNNN   # → edit/final.mp4
ss export <p> --approved-only --stems
```

## Revise (any edit)

Map the request to typed ops (`revise` skill table), state the timebase, apply, re-render, inspect the
changed range. Approved renders are never overwritten.

## Style and presets

`ss prefs import <p> reference.md` → fill the interpretation → `ss preset create <id> --from <base> --set …`
→ preview → `ss prefs add <p> "…" [--default only when told]`.
