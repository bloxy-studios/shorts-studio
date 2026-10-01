# Luxury Tech — design system

A bright, sparse world of floating white cards. **Source camera footage never moves**; all
motion lives in the graphics world. Hard picture cuts at every layout join; every run lands
on a sharp, composed first frame. Machine-readable values: `tokens.json` (this folder) and
`presets/editorial/luxury-tech.json` (rules with units/tolerances).

## Canvas and world

- 1080 × 1920 at **60 fps** delivery.
- Ground: radial near-white — `#FFFFFF` at (50%, 36%) fading to `#F3F3F0` at the edges.
  No grids, no dark backgrounds, no decorative orbs.
- Ink `#111111`. Clay fill `#D97757`, clay text on white `#B25730`. Highlight band `#FBEEE8`.
  Checks `#34C759`. Stamps `#FF3B30`.
- Object shadow (three layers):
  `0 60px 120px rgba(24,24,32,.16), 0 24px 48px rgba(24,24,32,.10), 0 4px 10px rgba(24,24,32,.06)`.
- Radii: media cards ≈ 3% of width (32 px), documents 40 px, tiles 72 px, phones 84 px,
  source-page frame 36 px, camera card 200 px.
- Type: Poppins. Headline 96/700, subhead 52/700, body 30/400. Nothing designed below 30 px.
- One dominant subject per run and at most one supporting cue. Negative space is the luxury.

## The three layouts

| Layout | Picture | Graphics | Captions |
| --- | --- | --- | --- |
| **A · Full camera** | Source cover-fitted to 1080×1920 with one stable crop decided at setup; no pan/zoom/punch-in inside the run. | None (CTA/outro overlay only when the speech asks for it). | y 1267–1536 (outro: 1037–1306) |
| **B · Split** | Camera card x −65, y 1200, 1210 × 864, radius 200, bleeding off the sides/bottom; footage revealed through the rounded window; matted head/shoulders rise above the card top with a ~40 px feather — same frame, same transform. | Full-canvas world; important content inside y 40–900, main graphic bottom edge ≈ 880–900; world fades out over 160 px below y 900. | y 941–1114 (the gap) |
| **C · Full visual** | None. | Full-canvas graphic or source-page/UI visual; required information above y ≈ 1230. | y 1267–1536, or y 365–634 when content sits low |

Sequencing: hook sentence → **split**; CTA/outro → **full camera**; opinions and direct-to-camera
punchlines → **full camera** only when the presenter is looking at the lens; screen recordings,
source pages and UI demos → **full visual**; a single card / screenshot / short list → **split**.
No uninterrupted run longer than ~8 s; avoid consecutive runs of the same layout; use all three
when the material supports it (otherwise log the exception).

**Eye contact.** Camera is shown only while head-orientation evidence says the presenter is
looking at the lens. A run whose speaker looks away becomes a full visual (or split at a word
boundary before the turn). This is evidence with uncertainty, verified on rendered frames.

**Matte.** The head layer is a real segmentation (HyperFrames `remove-background`, U²-Net human
segmentation, local CPU) of the *same source frame* under the *same transform* as the card. If the
matte flickers or tears, the run falls back to a contained camera card (no head break-out) and
the report says so.

## World camera (graphics only)

| Move | Duration | Ease | Limits |
| --- | --- | --- | --- |
| Glide | run length | `sine.inOut` | ≤ 0.04 scale change |
| Step to next subject | ≈ 0.5 s, starting ≈ 0.25 s before its naming word | `power3.inOut` | — |
| Push onto the discussed card | 1.2–2 s | `power2.inOut` | ≤ 1.6× while readable |
| Pull back to show relationships | 1–2 s | `power2.inOut` | — |
| Whip | 0.45 s depart + 0.6 s arrive | `power3.in` / `power3.out` | ≤ 1 per run |
| Inner product zoom (inside a held window) | 0.4–0.7 s | `power2.inOut` | 1.15–1.4× |

Depth of field during a push: the subject stays sharp; neighbours blur ≤ 14 px and dim ~30%;
the previous hero recedes to ~9 px blur / 40% opacity. Never blur text needed to follow the
point.

**Motion blur.** Velocity-based directional blur on the moving world layer only:
σ = 0.29 × speed(px/s) × (0.75 / 60), capped at 40 px, zero at rest (so landing frames are sharp).
That σ is the box-shutter equivalent of a 0.75 shutter at 60 fps. A sub-frame mode (240 fps render,
3-of-4 sample integration) is available for short windows and verified with a moving test card.
Footage, captions and source-page text are never blurred.

## Real UI and facts

Animate the action being explained (typing, click, response, streaming, a modal). Use real
captures or reconstructions grounded in official material; a reconstruction is labelled in the
report (and on screen where authenticity matters). Never invent product capabilities or an
"official" screenshot. Claims, figures and headlines get their real source page (frame at
x 24, y 200, 1032 × 1040, radius 36, white + shadow, over a washed blurred clone: 40 px blur,
0.7 saturation, 1.05 brightness, 72% white) and two independent sources where they exist.

## Captions

Poppins Bold 74 px white, 10 px black stroke, no box, 1–3 words per chunk, starting at the first
frame after frame zero. After two or three normal chunks, one or two meaningful words switch to
Instrument Serif *Italic* in `#FFFF00` at a comparable size and stroke (Instrument Serif has no
bold face; we use the real italic, never a synthesized bold). Never consecutive highlighted
chunks; never function words.

## Cover, CTA

Frame zero carries the title only: Poppins Bold ≈110 px, black on a white rounded box with soft
shadow, ~50 px side padding, in the y 262–603 region; the intro graphic stays below y 620 for that
frame. A separate cover image is exported. A CTA appears only when the speech or brief contains
one: a transparent comment box (x 43, y 1344, 994 × 276) where the real keyword types with a
finite blinking caret and a Post press — no invented "DM me".

## Audio

Original synthesized music (100–120 BPM, warm, minimal, no lead melody) at −24 LUFS with one
flat gain, first beat at frame one, ~800 ms fade ending at END. Voice ≈ −14 LUFS. SFX only for
meaningful visible events: bubbly click (press), key ticks (typing), dull pop (landing),
two-note chime (answer/confirmation), filtered whoosh peaked at a whip midpoint (≤ 1 per run,
≤ 3 per short, varied), and a 2–3 s riser ending at the hook → first-point join. No SFX on
layout cuts, steps, pushes or glides. Master ≈ −14 LUFS, ≤ −1 dBTP.
