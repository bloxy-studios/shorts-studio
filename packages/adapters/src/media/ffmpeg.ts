import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { run, type RunOptions } from "../proc.ts";
import { tool } from "../tools.ts";

const BASE = ["-hide_banner", "-nostdin", "-y", "-v", "error"];

/** Writes to a temp path then renames, so an interrupted encode never looks complete. */
async function ffmpegTo(out: string, args: string[], opts: RunOptions = {}): Promise<void> {
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.partial${out.slice(out.lastIndexOf("."))}`;
  await run([tool("ffmpeg"), ...BASE, ...args, tmp], { timeoutMs: 6 * 3600_000, ...opts });
  renameSync(tmp, out);
}

/**
 * Extracts one audio stream as PCM WAV aligned to container time zero: any
 * leading gap before the stream's first packet is filled with silence, so
 * sample index / rate == source time (the convention every analysis relies on).
 */
export async function extractAudio(
  src: string,
  out: string,
  opts: { rate: number; channels: number; streamIndex: number; codec?: "pcm_s16le" | "pcm_s24le" },
  run_opts: RunOptions = {},
): Promise<void> {
  await ffmpegTo(
    out,
    ["-i", src, "-map", `0:${opts.streamIndex}`, "-af", "aresample=async=1:first_pts=0", "-ac", `${opts.channels}`, "-ar", `${opts.rate}`, "-c:a", opts.codec ?? "pcm_s16le"],
    run_opts,
  );
}

/**
 * Low-resolution analysis proxy (short side 360 px, 1 s GOP for fast seeks).
 * Timestamps pass through unchanged so VFR sources keep their true times.
 */
export async function makeProxy(src: string, out: string, displayW: number, displayH: number, runOpts: RunOptions = {}): Promise<{ width: number; height: number }> {
  const short = 360;
  let w: number;
  let h: number;
  if (displayW >= displayH) {
    h = short;
    w = Math.round((displayW / displayH) * short / 2) * 2;
  } else {
    w = short;
    h = Math.round((displayH / displayW) * short / 2) * 2;
  }
  await ffmpegTo(
    out,
    ["-i", src, "-map", "0:v:0", "-an", "-sn", "-fps_mode", "passthrough", "-vf", `scale=${w}:${h}:flags=bicubic,format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-g", "30", "-keyint_min", "15", "-movflags", "+faststart"],
    runOpts,
  );
  return { width: w, height: h };
}

/** Scene cuts via FFmpeg's scdet (frame-accurate on the proxy). Returns cut times in seconds. */
export async function detectSceneCuts(video: string, threshold = 10, runOpts: RunOptions = {}): Promise<Array<{ t: number; score: number }>> {
  const res = await run([tool("ffmpeg"), "-hide_banner", "-nostdin", "-i", video, "-map", "0:v:0", "-vf", `scdet=threshold=${threshold}`, "-f", "null", "-"], {
    timeoutMs: 3 * 3600_000,
    ...runOpts,
  });
  const cuts: Array<{ t: number; score: number }> = [];
  const re = /lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*([\d.]+)/g;
  for (const m of res.stderr.matchAll(re)) cuts.push({ score: Number(m[1]), t: Number(m[2]) });
  return cuts;
}

/** Black stretches (e.g. gaps between soundbites in a compilation). Seconds. */
export async function detectBlack(video: string, minDurS = 0.2, runOpts: RunOptions = {}): Promise<Array<{ start: number; end: number }>> {
  const res = await run([tool("ffmpeg"), "-hide_banner", "-nostdin", "-i", video, "-map", "0:v:0", "-vf", `blackdetect=d=${minDurS}:pix_th=0.08`, "-an", "-f", "null", "-"], {
    timeoutMs: 3 * 3600_000,
    allowFailure: true,
    ...runOpts,
  });
  return [...res.stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
}

export interface Ebur128 {
  integratedLufs: number | null;
  lraLu: number | null;
  truePeakDbtp: number | null;
  samplePeakDbfs: number | null;
}

/** FFmpeg EBU R128 measurement with oversampled true peak (independent cross-check of pyloudnorm). */
export async function measureEbur128(file: string, runOpts: RunOptions = {}): Promise<Ebur128> {
  const res = await run([tool("ffmpeg"), "-hide_banner", "-nostdin", "-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true+sample:framelog=quiet", "-f", "null", "-"], {
    timeoutMs: 3600_000,
    allowFailure: true,
    ...runOpts,
  });
  const summary = res.stderr.slice(res.stderr.lastIndexOf("Summary:"));
  const pick = (re: RegExp): number | null => {
    const m = re.exec(summary);
    if (!m) return null;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  return {
    integratedLufs: pick(/I:\s*(-?[\d.]+|-inf)\s*LUFS/),
    lraLu: pick(/LRA:\s*(-?[\d.]+)\s*LU/),
    truePeakDbtp: pick(/True peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/),
    samplePeakDbfs: pick(/Sample peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/),
  };
}

/** Accurate single-frame grab to PNG/JPEG (input seek then decode forward). */
export async function grabFrame(src: string, tSec: number, out: string, width?: number, runOpts: RunOptions = {}): Promise<void> {
  const vf = width ? ["-vf", `scale=${width}:-2:flags=bicubic`] : [];
  await ffmpegTo(out, ["-ss", tSec.toFixed(6), "-i", src, "-map", "0:v:0", "-frames:v", "1", ...vf, "-update", "1"], runOpts);
}

export function exists(path: string): boolean {
  return existsSync(path);
}
