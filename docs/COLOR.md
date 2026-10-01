# Colour management

## Delivery

Every render is H.264 `yuv420p`, BT.709 primaries/transfer/matrix, TV (limited) range, tagged in
the stream (`-colorspace/-color_primaries/-color_trc/-color_range`) and in the x264 VUI. QA's
`export.spec` records the tags of the delivered file.

## SDR sources

Footage is converted with explicit matrices (`scale=…:in_color_matrix=auto:out_color_matrix=bt709:out_range=tv`).
Untagged sources fall back to FFmpeg's auto detection; the probe records what it saw.

## Overlays (captions, cover, CTA, graphics, card, head)

Overlays are composited **in YUV**: each RGBA overlay is converted once with the BT.709 matrix
(`scale=out_color_matrix=bt709:out_range=tv,format=yuva420p`) and `overlay=format=yuv420`.
`overlay=format=auto` with an RGBA input was measured to round-trip the whole frame through RGB
with the BT.601 matrix and darken flat colours by ~3 levels (Luxury ground `#F2F2ED → #EFEFEA`);
it is no longer used. QA check `luxury.ground` samples empty ground points against the token.

## HDR sources (PQ / HLG)

The probe flags `isHDR` from the transfer characteristic (`smpte2084` → PQ, `arib-std-b67` → HLG).
Analysis proxies are not tone mapped (CV works on luma). **Renders always tone map** before any
crop/scale, and the Luxury card/matte clips are extracted already tone mapped, so card and matte see
identical SDR frames.

The bundled FFmpeg has no libzimg (`zscale`), so the path is a generated 3D LUT
(`python … color.hdr_lut`, cached in `<runtime>/cache/color/`):

1. limited-range BT.2020 YUV → full-range RGB (`scale=in_color_matrix=bt2020`), `rgb48le`;
2. LUT (33³, tetrahedral): decode PQ (ST 2084) or HLG (inverse OETF + OOTF, system gamma 1.2,
   1000-nit display) to display light; normalise to the BT.2408 reference white (203 nits);
   hue-preserving luminance tone curve — linear below 0.75, exponential shoulder normalised so the
   mastering peak (1000 nits) reaches 1.0; BT.2020 → BT.709 primaries; channels above white scaled
   together (hue kept); BT.1886 inverse (γ 2.4);
3. BT.709 TV-range YUV, re-tagged with `setparams` so later scales treat it as BT.709.

Verified (`bun tests/integration/hdr.verify.ts`) on synthetic 10-bit PQ and HLG clips:

| Patch | PQ → SDR | HLG → SDR | Expected | Naive BT.709 conversion (PQ) |
| --- | --- | --- | --- | --- |
| 36.5 nits (18 % of ref. white) | 125 | 124 | 125 | 102 |
| 100 nits | 190 | 190 | 190 | 127 |
| 203 nits (ref. white) | 244 | 245 | 245 | 145 (washed out) |
| 1000 nits (peak) | 255 | 255 | 255 | 188 |
| BT.2020 red | 255,0,49 | 246,0,46 | hue kept | 144,73,74 (desaturated) |

Limits: a single static curve (no per-scene metadata such as Dolby Vision RPUs or HDR10+); mastering
peak assumed 1000 nits unless configured.
