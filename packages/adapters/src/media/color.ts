/**
 * HDR → SDR colour management (docs/COLOR.md). The bundled FFmpeg has no zimg, so PQ/HLG
 * BT.2020 sources go through a generated 3D LUT (python ext_color): BT.2408 reference white
 * (203 nits) → SDR white region, hue-preserving shoulder to the mastering peak, BT.709 primaries.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../env.ts";
import { py } from "../python.ts";

export type HdrKind = "pq" | "hlg";

/** Cached LUT path for a transfer + mastering peak; filter-safe (no characters that need escaping). */
export async function hdrLut(kind: HdrKind, peakNits = 1000): Promise<string> {
  const dir = join(paths().runtimeHome, "cache", "color");
  mkdirSync(dir, { recursive: true });
  const lut = join(dir, `${kind}-bt2020-to-sdr709-${peakNits}.cube`);
  if (!existsSync(lut)) await py("color.hdr_lut", { kind, peakNits, size: 33, out: lut });
  if (!/^[\w./-]+$/.test(lut)) {
    const safe = join(tmpdir(), `ss-${kind}-${peakNits}.cube`);
    copyFileSync(lut, safe);
    return safe;
  }
  return lut;
}

/**
 * FFmpeg chain: limited-range BT.2020 YUV → full-range RGB → LUT → BT.709 limited YUV,
 * re-tagged so downstream `in_color_matrix=auto` scales treat it as BT.709.
 */
export function hdrToSdrFilter(lut: string): string {
  return [
    "scale=in_color_matrix=bt2020:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int",
    "format=rgb48le",
    `lut3d=file=${lut}:interp=tetrahedral`,
    "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int",
    "format=yuv444p10le",
    "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
  ].join(",");
}
