# Example outputs

Real outputs from the demo projects (public-domain NASA footage + synthetic test audio). Full
renders stay in `projects/` (git-ignored); these are the small review copies.

| Folder | What it shows | Produced by |
| --- | --- | --- |
| `luxury-creator-edit/` | Creator Edit + Luxury Tech on a direct-to-camera soundbite (astronaut Reid Wiseman): verified mic sync, all three layouts, head break-out matte, word-anchored graphics (radar → systems → car whip, checklist, tiles), cover, synth music/SFX, 60 fps; QA pass-with-warnings (1 caption chunk early) with recorded frame review | `shorts-studio creator creator-luxury --camera … --mic … --preset luxury-tech`, director `graphics.json`, `luxury plan`, `render`, `qa note`, `approve` |
| `creator-takes-luxury/` | Creator Edit on a scripted retake session (synthetic voice): take choices vs ground truth (last take, earlier take for a stutter, false start + chatter removed); Luxury Tech with the camera withheld because the presenter never looks at the lens (logged exception) — UI demonstrations carry the edit | same flow on `tests/fixtures/generated/creator-takes` |
| `youtube-clip/` | `/shorts-studio:clip` on NASA's ISS interview (YouTube `b8K96XHxi7I`): ranked candidates with evidence, approved clip after a natural-language revision ("keep both people visible") | `ingest` (yt-dlp) → `transcribe` → `analyze` → `candidates` → `plan` → `render` → `revise` → `approve` → `export` |
| `motion-blur-verification.json`, `motion-blur-compare.png` | Moving test edge (1200 px/s): rest vs velocity blur vs 240→60 fps sub-frame integration, measured 10–90 % edge widths | `bun tests/integration/motion-blur.verify.ts` |

Each render folder has `report.md` (editing report: decisions, measurements, exceptions, inspections),
`qa.json` (every measured check), the contact/cut sheets that were inspected, the cover and a 540×960 preview.
