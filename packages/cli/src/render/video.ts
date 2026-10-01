import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { flicksPerFrame, flicksToSeconds, formatRational, type CropPath, type EditPlan, type Flicks, type LayoutSlot, type SourceAsset } from "../../../core/src/index.ts";
import { run } from "../../../adapters/src/proc.ts";
import { tool } from "../../../adapters/src/tools.ts";
import { hdrLut, hdrToSdrFilter } from "../../../adapters/src/media/color.ts";
import { cancellation } from "../jobs.ts";
import { info, stage } from "../ui.ts";
import type { LuxuryLayers } from "../luxury/render.ts";

export interface Piece {
  outStart: Flicks;
  outEnd: Flicks;
  sourceId: string;
  srcStart: Flicks;
  cropPathId: string | null;
  runId: string;
  segmentId: string;
  slots: LayoutSlot[];
}

/** Intersects picture segments with layout runs (both tile [0, END)). */
export function pieces(plan: EditPlan): Piece[] {
  const cuts = new Set<number>([0, plan.output.durationFlicks]);
  for (const s of plan.segments) {
    cuts.add(s.picture.outStart);
    cuts.add(s.picture.outEnd);
  }
  for (const r of plan.layoutRuns) {
    cuts.add(r.outStart);
    cuts.add(r.outEnd);
  }
  const sorted = [...cuts].filter((c) => c >= 0 && c <= plan.output.durationFlicks).sort((a, b) => a - b);
  const out: Piece[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const seg = plan.segments.find((s) => a >= s.picture.outStart && a < s.picture.outEnd);
    const runEntry = plan.layoutRuns.find((r) => a >= r.outStart && a < r.outEnd);
    if (!seg || !runEntry) throw new Error(`timeline hole at ${a}`);
    const main = runEntry.slots.find((s) => s.slot === "main") ?? runEntry.slots[0];
    out.push({
      outStart: a,
      outEnd: b,
      sourceId: seg.picture.sourceId,
      srcStart: seg.picture.srcStart + (a - seg.picture.outStart),
      cropPathId: main?.cropPathId ?? null,
      runId: runEntry.id,
      segmentId: seg.id,
      slots: runEntry.slots,
    });
  }
  return out;
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** ffmpeg expression for a crop coordinate along keyframes (piecewise linear/hold in output time). */
function coordExpr(path: CropPath, key: "x" | "y", pieceStartSec: number): string {
  const ks = path.keyframes;
  if (ks.length === 1 || path.interpolation === "hold") return `${Math.round(ks[0]!.box[key])}`;
  // t inside the filter restarts at 0 for each piece; offset to output time.
  let expr = `${Math.round(ks[ks.length - 1]!.box[key])}`;
  for (let i = ks.length - 2; i >= 0; i--) {
    const k0 = ks[i]!;
    const k1 = ks[i + 1]!;
    const t0 = flicksToSeconds(k0.t) - pieceStartSec;
    const t1 = flicksToSeconds(k1.t) - pieceStartSec;
    const v0 = k0.box[key];
    const v1 = k1.box[key];
    const span = Math.max(1e-6, t1 - t0);
    const lin = path.interpolation === "smooth" ? `(${v0}+(${v1 - v0})*(3*pow(((t-${t0})/${span}),2)-2*pow(((t-${t0})/${span}),3)))` : `(${v0}+(${v1 - v0})*((t-${t0})/${span}))`;
    expr = `if(lt(t,${t0.toFixed(6)}),${Math.round(v0)},if(lt(t,${t1.toFixed(6)}),${lin},${expr}))`;
  }
  return `'${expr}'`;
}

export interface Overlay {
  path: string;
  x: number;
  y: number;
  /** Decoder hint for alpha codecs (e.g. libvpx-vp9 for VP9 alpha). */
  decoder?: string;
  /** Extra input options (e.g. -loop 1 for a still). */
  inputArgs?: string[];
  /** ffmpeg timeline expression (quoted in the graph), e.g. eq(n,0) for frame zero only. */
  enable?: string;
}

export interface VideoRequest {
  plan: EditPlan;
  sources: Map<string, SourceAsset>;
  overlays: Overlay[];
  audioPath: string;
  output: string;
  /** Draft: faster x264 preset, same geometry and timing. */
  draft: boolean;
  /** Luxury Tech graphics/matte layers (required when the plan has lt-* runs). */
  luxury?: LuxuryLayers | null;
}

export async function composeVideo(req: VideoRequest): Promise<{ command: string; seconds: number }> {
  const { plan } = req;
  const fps = plan.output.fps;
  const frame = flicksPerFrame(fps);
  const W = plan.output.width;
  const H = plan.output.height;
  const ps = pieces(plan);
  const args = [tool("ffmpeg"), "-hide_banner", "-nostdin", "-y", "-v", "error", "-stats_period", "5", "-progress", "pipe:2"];
  const labels: string[] = [];
  const filters: string[] = [];
  let inputs = 0;
  const addInput = (...a: string[]): number => {
    args.push(...a);
    return inputs++;
  };
  // HDR (PQ/HLG) sources are tone mapped to SDR BT.709 before any crop/scale (docs/COLOR.md).
  const hdr = new Map<string, string>();
  for (const s of req.sources.values()) if (s.probe.video?.isHDR && s.probe.video.hdrKind) hdr.set(s.id, hdrToSdrFilter(await hdrLut(s.probe.video.hdrKind)));
  ps.forEach((piece, i) => {
    const src = req.sources.get(piece.sourceId);
    if (!src?.probe.video) throw new Error(`source ${piece.sourceId} has no video`);
    const frames = Math.round((piece.outEnd - piece.outStart) / frame);
    const runEntry = plan.layoutRuns.find((r) => r.id === piece.runId)!;
    if (runEntry.layout === "lt-full-visual" || runEntry.layout === "lt-split") {
      filters.push(...luxuryPiece(req, piece, i, frames, addInput));
      labels.push(`[p${i}]`);
      return;
    }
    const startSec = flicksToSeconds(piece.srcStart);
    const srcIdx = addInput("-ss", startSec.toFixed(6), "-t", (frames / (fps.num / fps.den) + 0.25).toFixed(6), "-i", src.localPath);
    const pieceStart = flicksToSeconds(piece.outStart);
    const tone = hdr.get(piece.sourceId);
    const head = `[${srcIdx}:v:0]${tone ? `${tone},` : ""}fps=fps=${formatRational(fps)}:round=near,trim=end_frame=${frames},setpts=PTS-STARTPTS`;
    const scaleTo = (w: number, h: number) => `scale=${even(w)}:${even(h)}:flags=lanczos+accurate_rnd+full_chroma_int:in_color_matrix=auto:out_color_matrix=bt709:out_range=tv`;
    const cropOf = (path: CropPath) => {
      const box = path.keyframes[0]!.box;
      return `crop=w=${even(box.w)}:h=${even(box.h)}:x=${coordExpr(path, "x", pieceStart)}:y=${coordExpr(path, "y", pieceStart)}:exact=1`;
    };
    const slots = piece.slots.length ? piece.slots : [];
    const single = slots.length <= 1 && (!slots[0] || (slots[0].region.x === 0 && slots[0].region.y === 0 && slots[0].region.w === W && slots[0].region.h === H && !slots[0].blurPx && !slots[0].dim));
    if (single) {
      const crop = plan.cropPaths.find((c) => c.id === piece.cropPathId);
      filters.push(`${head},${crop ? `${cropOf(crop)},` : ""}${scaleTo(W, H)},setsar=1,format=yuv420p[p${i}]`);
    } else {
      // Multi-slot layout: each slot crops the same source frame, is scaled into its region
      // (optionally blurred/dimmed for a backdrop) and composited over a black canvas.
      const dur = (frames / (fps.num / fps.den)).toFixed(6);
      filters.push(`${head},split=${slots.length}${slots.map((_, k) => `[s${i}_${k}]`).join("")}`);
      filters.push(`color=c=black:s=${W}x${H}:r=${formatRational(fps)}:d=${dur},format=yuv420p[bg${i}]`);
      let lastLabel = `bg${i}`;
      slots.forEach((slot, k) => {
        const path = plan.cropPaths.find((c) => c.id === slot.cropPathId);
        const parts = [path ? cropOf(path) : null, scaleTo(slot.region.w, slot.region.h), "setsar=1"];
        if (slot.blurPx > 0) parts.push(`gblur=sigma=${(slot.blurPx / 2).toFixed(2)}`);
        if (slot.dim > 0) parts.push(`eq=brightness=${(-slot.dim * 0.5).toFixed(3)}:saturation=${(1 - slot.dim * 0.4).toFixed(3)}`);
        parts.push("format=yuv420p");
        filters.push(`[s${i}_${k}]${parts.filter(Boolean).join(",")}[c${i}_${k}]`);
        const out = k === slots.length - 1 ? `p${i}` : `o${i}_${k}`;
        filters.push(`[${lastLabel}][c${i}_${k}]overlay=x=${Math.round(slot.region.x)}:y=${Math.round(slot.region.y)}:shortest=1${k === slots.length - 1 ? ",trim=end_frame=" + frames + ",setsar=1,format=yuv420p" : ""}[${out}]`);
        lastLabel = out;
      });
    }
    labels.push(`[p${i}]`);
  });
  filters.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[base]`);
  let last = "base";
  req.overlays.forEach((ov, j) => {
    const idx = addInput(...(ov.decoder ? ["-c:v", ov.decoder] : []), ...(ov.inputArgs ?? []), "-i", ov.path);
    // RGBA overlays are converted to YUVA with the BT.709 matrix here, and the overlay runs in
    // YUV: `format=auto` would round-trip the whole frame through RGB (BT.601), shifting every
    // flat colour by ~3 levels (measured on the Luxury ground: #F2F2ED → #EFEFEA).
    filters.push(`[${idx}:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[ov${j}]`);
    filters.push(`[${last}][ov${j}]overlay=x=${ov.x}:y=${ov.y}:format=yuv420:eof_action=pass:repeatlast=0${ov.enable ? `:enable='${ov.enable}'` : ""}[o${j}]`);
    last = `o${j}`;
  });
  filters.push(`[${last}]format=yuv420p[vout]`);
  const audioIdx = addInput("-i", req.audioPath);
  const x264 = req.draft ? ["-preset", "veryfast", "-crf", "23"] : ["-preset", plan.output.video.preset, "-crf", String(plan.output.video.crf)];
  const out = req.output;
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.partial.mp4`;
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    `${audioIdx}:a:0`,
    "-frames:v",
    String(plan.output.frameCount),
    "-r",
    formatRational(fps),
    "-c:v",
    "libx264",
    ...x264,
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(Math.round((fps.num / fps.den) * 2)),
    "-x264-params",
    "colorprim=bt709:transfer=bt709:colormatrix=bt709",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_range",
    "tv",
    "-c:a",
    "aac",
    "-b:a",
    `${plan.output.audio.bitrateKbps}k`,
    "-ar",
    String(plan.output.sampleRate),
    "-ac",
    String(plan.output.audioChannels),
    "-movflags",
    "+faststart",
    "-metadata",
    `comment=Shorts Studio ${plan.clipId} plan v${plan.version}`,
    tmp,
  );
  stage("video", `${ps.length} piece(s), ${req.overlays.length} overlay(s), ${plan.output.frameCount} frames @ ${formatRational(fps)} fps${req.draft ? " (draft encode)" : ""}`);
  const started = performance.now();
  let lastReport = 0;
  const res = await run(args, {
    timeoutMs: 6 * 3600_000,
    signal: cancellation.signal,
    onStderrLine: (l) => {
      const m = /^frame=(\d+)/.exec(l);
      if (m && performance.now() - lastReport > 5000) {
        lastReport = performance.now();
        info(`  encoded ${m[1]}/${plan.output.frameCount} frames`);
      }
    },
  });
  renameSync(tmp, out);
  return { command: res.command, seconds: (performance.now() - started) / 1000 };
}

/**
 * Luxury Tech pieces. Full visual: the run's graphics, frame-exact. Split: graphics,
 * then the card footage through its rounded window, then the matted head from the
 * same clip under the same scale/offset, alpha × feather ramp at the card top.
 */
function luxuryPiece(req: VideoRequest, piece: Piece, i: number, frames: number, addInput: (...a: string[]) => number): string[] {
  const { plan } = req;
  const lt = req.luxury;
  if (!lt) throw new Error("Luxury Tech layers were not rendered for this plan");
  const fps = formatRational(plan.output.fps);
  const runEntry = plan.layoutRuns.find((r) => r.id === piece.runId)!;
  const g = lt.graphics.get(piece.runId);
  if (!g) throw new Error(`no graphics render for ${piece.runId}`);
  const off = Math.round((piece.outStart - runEntry.outStart) / flicksPerFrame(plan.output.fps));
  const gi = addInput("-i", g.path);
  const graphics = `[${gi}:v:0]trim=start_frame=${off}:end_frame=${off + frames},setpts=PTS-STARTPTS,format=yuv420p,setsar=1`;
  if (runEntry.layout === "lt-full-visual") return [`${graphics}[p${i}]`];
  const media = lt.pieces.get(i);
  const card = runEntry.slots.find((s) => s.mask);
  if (!media || !card || !lt.masks.card) throw new Error(`split piece ${i} is missing its clip, card slot or mask`);
  const crop = plan.cropPaths.find((c) => c.id === card.cropPathId)!;
  const box = crop.keyframes[0]!.box;
  const s = card.region.w / box.w;
  const X = card.region.x - s * box.x;
  const Y = card.region.y - s * box.y;
  const src = req.sources.get(piece.sourceId)!;
  const SW = even(src.probe.video!.displayWidth * s);
  const SH = even(src.probe.video!.displayHeight * s);
  const ox = Math.round(-X);
  const oyCard = Math.round(card.region.y - Y);
  if (ox < 0 || ox + card.region.w > SW || oyCard < 0 || oyCard + card.region.h > SH) throw new Error(`split card window leaves the scaled source (${SW}x${SH} at ${ox},${oyCard})`);
  const head = runEntry.slots.find((s2) => s2.matte);
  const useHead = Boolean(head && media.matte && lt.masks.ramp);
  const out: string[] = [`${graphics}[g${i}]`];
  const ci = addInput("-i", media.clip);
  const scale = `scale=${SW}:${SH}:flags=lanczos+accurate_rnd+full_chroma_int:in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=tv`;
  out.push(`[${ci}:v:0]${scale},fps=fps=${fps}:round=near,trim=end_frame=${frames},setpts=PTS-STARTPTS${useHead ? `,split=2[cs${i}][hs${i}]` : `[cs${i}]`}`);
  const ki = addInput("-loop", "1", "-framerate", fps, "-i", lt.masks.card);
  out.push(`[cs${i}]crop=${card.region.w}:${card.region.h}:${ox}:${oyCard},format=yuva420p[cc${i}]`);
  out.push(`[${ki}:v:0]format=gray,trim=end_frame=${frames},setpts=PTS-STARTPTS[ck${i}]`);
  out.push(`[cc${i}][ck${i}]alphamerge[card${i}]`);
  out.push(`[g${i}][card${i}]overlay=x=${card.region.x}:y=${card.region.y}:format=yuv420:shortest=1${useHead ? "" : ",format=yuv420p,setsar=1"}[${useHead ? `b${i}` : `p${i}`}]`);
  if (useHead && head && media.matte && lt.masks.ramp) {
    const oyHead = Math.round(head.region.y - Y);
    if (oyHead < 0) throw new Error(`head band starts above the scaled source (${oyHead})`);
    const mi = addInput("-i", media.matte);
    const ri = addInput("-loop", "1", "-framerate", fps, "-i", lt.masks.ramp);
    out.push(`[${mi}:v:0]format=yuva444p,alphaextract,scale=${SW}:${SH}:flags=bicubic,fps=fps=${fps}:round=near,trim=end_frame=${frames},setpts=PTS-STARTPTS,crop=${head.region.w}:${head.region.h}:${ox}:${oyHead}[ma${i}]`);
    out.push(`[${ri}:v:0]format=gray,trim=end_frame=${frames},setpts=PTS-STARTPTS[mr${i}]`);
    out.push(`[ma${i}][mr${i}]blend=all_mode=multiply,format=gray[mm${i}]`);
    out.push(`[hs${i}]crop=${head.region.w}:${head.region.h}:${ox}:${oyHead},format=yuva420p[hc${i}]`);
    out.push(`[hc${i}][mm${i}]alphamerge[head${i}]`);
    out.push(`[b${i}][head${i}]overlay=x=${head.region.x}:y=${head.region.y}:format=yuv420:shortest=1,format=yuv420p,setsar=1[p${i}]`);
  }
  return out;
}

export async function makePreview(input: string, output: string): Promise<void> {
  await run([tool("ffmpeg"), "-hide_banner", "-nostdin", "-y", "-v", "error", "-i", input, "-vf", "scale=540:960:flags=bicubic", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", output], { timeoutMs: 3600_000 });
}
