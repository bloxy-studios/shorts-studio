# Test fixtures

Fixtures are reproducible from public-domain footage plus synthetic audio. Large media are
git-ignored (`downloaded/`, `generated/`); this file says how to recreate them.

## Downloaded source (public domain)

`downloaded/nasa-artemis-soundbites.mp4` — NASA Artemis program soundbites (1280×720, 30 fps):
Jim Bridenstine (16–181 s, looks off-axis at an interviewer), astronaut Reid Wiseman (194–306 s,
speaks to the lens), Jeanette Epps (from ~319 s). Download it from NASA's media library (NASA content
is generally not copyrighted in the US; media usage guidelines apply) and place it at that path.
The YouTube end-to-end example uses NASA's ISS interview `b8K96XHxi7I` (fetched by `shorts-studio ingest`).

## Generated (`bun`-free, Python): `.runtime/venv/bin/python tests/fixtures/make_fixtures.py [--only sync|takes|luxury]`

| Fixture | Camera | Clean mic | Ground truth (`truth.json`) | Tests |
| --- | --- | --- | --- | --- |
| `creator-sync/` | NASA 18–93 s with degraded (reverb/band-limit/hiss) camera audio | original audio, started 1.75 s earlier | offset 1.75 s, drift 40 ppm; lips match | sync accuracy, drift fit, spot checks |
| `creator-takes/` | NASA reel spans 16.2–36.3 + 37.5–57.3 s (black-free, joined by a hard cut) with degraded camera audio | macOS `say` take session: chatter, repeated L1, false start of L3, stuttered last take of L4 | offset 2.4 s; expected take per line; removed items | take policy, false starts, chatter, defect swap; eye-contact exception path (presenter looks away) |
| `creator-luxury/` | NASA 223.8–250.6 s (Reid Wiseman, direct to camera) with degraded camera audio | original audio, started 1.3 s earlier | offset 1.3 s; lips match | Luxury Tech layouts, eye contact, head matte, graphics |

Synthetic voices do not match lips (they exist to test take selection). Measured results against
these truths are recorded in `docs/VALIDATION.md`.

## Other synthetic checks (generated on the fly)

- `tests/integration/motion-blur.verify.ts` — moving black/white edge for motion-blur measurement.
- `tests/integration/hdr.verify.ts` — 10-bit PQ and HLG clips with known patch luminances.
