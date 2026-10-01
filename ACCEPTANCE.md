# Acceptance criteria

The build is complete only when each item below has evidence recorded in
`docs/VALIDATION.md` (command, output path, measurement). "Done" never means only
"FFmpeg exited 0".

| # | Criterion | Evidence required |
| --- | --- | --- |
| A1 | Plugin loads in the verified Claude Code version; user workflows discoverable | `claude plugin validate . --strict --json`, `claude --plugin-dir . plugin details shorts-studio` listing skills |
| A2 | `/shorts-studio:clip` ingests an accessible source and produces real selected clips with evidence | Project folder with candidates.json (evidence, scores), rendered MP4s, reports |
| A3 | Analysis distinguishes transcript-only fallback from audiovisual inspection | `analysisLevel` + coverage in candidates/report; a forced transcript-only run labelled as such |
| A4 | Interactive edit uses real AskUserQuestion choices and visual style samples | Caption preview sheet + samples; skill instructions invoking AskUserQuestion; transcript of a guided run |
| A5 | Speaker-aware framing works on a two-speaker fixture and degrades safely when uncertain | Crop path with verified switches + a low-confidence run falling back to stack/wide; debug overlay frames |
| A6 | Caption timings stay correct after cuts/J-cuts; subtitles exportable | Unit tests (retime, J-cut) + QA comparing caption onsets with final voice track; SRT/VTT/words.json |
| A7 | Creator Edit selects takes, aligns clean audio, produces a coherent recording | Sync report (offset, drift, spot checks), take table with swaps, `edit/final.mp4` |
| A8 | Luxury Tech produces a verified representative edit (or reports source-specific exceptions) | Layout-runs table, 1080×1920@60, static footage check, caption zones, semantic highlights, matte/card frame identity, SFX rules |
| A9 | Code-generated stems are full-length, aligned, measured, remixable | stems/*.wav equal length = END, 48 kHz; loudness/true-peak table |
| A10 | Adaptive director refines a brief from an actual QA finding and rebuilds the affected output | brief-v001 → brief-v002 change log citing the finding; only implicated stages re-ran |
| A11 | Natural-language revision changes the intended part and preserves approved work | Plan diff v(n)→v(n+1) touching only targeted ids; previous approved render intact |
| A12 | Final media decodes; technical/visual/audio checks recorded honestly | qa.json + report.md per render, including not-run checks |
| A13 | Manifest validation, core tests, end-to-end local demo run | `bun test`, `pytest`, `tsc`, validate output, demo command log |
| A14 | Instructions, reports, editable source and example outputs exist; no undocumented global setup | README/docs/SETUP.md, examples/, `doctor` output on a clean runtime |
