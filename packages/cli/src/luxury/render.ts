/**
 * Renders the Luxury Tech layers that FFmpeg composites around the footage:
 * per-run graphics (HyperFrames), per-piece head mattes (HyperFrames background
 * removal on the exact clip the card plays), masks, and the frame-zero cover.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flicksPerFrame, flicksToSeconds, type EditPlan, type MetricsTable, type SourceAsset } from "../../../core/src/index.ts";
import type { CompiledGraphic } from "../../../core/src/luxury/graphics.ts";
import { paths } from "../../../adapters/src/env.ts";
import { hfLint, hfRemoveBackground, hfRender } from "../../../adapters/src/hyperframes.ts";
import { CTA_MARGIN, writeCoverComposition, writeCtaComposition, writeLuxuryComposition } from "../../../adapters/src/render/luxury.ts";
import { py } from "../../../adapters/src/python.ts";
import { run } from "../../../adapters/src/proc.ts";
import { tool } from "../../../adapters/src/tools.ts";
import { hdrLut, hdrToSdrFilter } from "../../../adapters/src/media/color.ts";
import { cancellation } from "../jobs.ts";
import { P, type Project } from "../project.ts";
import { info, stage, warn } from "../ui.ts";
import { pieces, type Piece } from "../render/video.ts";

export interface LtGraphicRender {
  runId: string;
  path: string;
  frames: number;
  cached: boolean;
  seconds: number;
  blurFrames: number;
  peakSigma: number;
  compositionDir: string;
}

export interface MatteQa {
  ok: boolean;
  frames: number;
  iouMean: number;
  iouMin: number;
  edgeFlickerMean: number;
  unstableTransitions: number;
  alignment: { aligned: boolean | null; probes: unknown[]; clipFrames: number; matteFrames: number } | null;
  issues: string[];
}

export interface LtPieceMedia {
  /** Clip of exactly the source span the card plays (card + matte read the same frames). */
  clip: string;
  matte: string | null;
  qa: MatteQa | null;
  fallback: string | null;
  cached: boolean;
}

export interface LuxuryLayers {
  graphics: Map<string, LtGraphicRender>;
  /** Keyed by piece index. */
  pieces: Map<number, LtPieceMedia>;
  masks: { card: string | null; ramp: string | null };
  cover: string | null;
  /** Outro CTA overlay (transparent MOV) and where/when it sits on the canvas. */
  cta: { path: string; x: number; y: number; startSec: number; endSec: number } | null;
  notes: string[];
}

function sha(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function frameCount(path: string): Promise<number> {
  const r = await run([tool("ffprobe"), "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path], { timeoutMs: 300_000 });
  return Number(r.stdout.trim());
}

async function renderGraphics(p: Project, plan: EditPlan, metrics: MetricsTable, draft: boolean, notes: string[]): Promise<Map<string, LtGraphicRender>> {
  const out = new Map<string, LtGraphicRender>();
  const frame = flicksPerFrame(plan.output.fps);
  const fps = plan.output.fps.num / plan.output.fps.den;
  const root = join(P.clip(p, plan.clipId), "cache", "lt");
  mkdirSync(root, { recursive: true });
  for (const g of plan.graphics.filter((x) => x.template === "lt-world")) {
    const runEntry = plan.layoutRuns.find((r) => r.id === g.runId);
    if (!runEntry) throw new Error(`graphic ${g.id} has no run ${g.runId}`);
    const props = g.props as { compiled: CompiledGraphic; cover?: boolean };
    const frames = Math.round((runEntry.outEnd - runEntry.outStart) / frame);
    const work = join(root, `${g.runId}-work`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const comp = writeLuxuryComposition(work, props.compiled, {
      fps,
      frames,
      split: runEntry.layout === "lt-split",
      cover: props.cover && plan.cover?.frameZero ? { title: plan.cover.title } : null,
      motionBlur: { enabled: g.motionBlur?.enabled ?? true, shutter: g.motionBlur?.shutter ?? 0.75, maxSigma: 40 },
      subframes: g.motionBlur?.samplesPerFrame && g.motionBlur.samplesPerFrame > 1 ? g.motionBlur.samplesPerFrame : 1,
      metrics,
    });
    const key = sha(readFileSync(join(work, "index.html")) + (draft ? "draft" : "final") + "v1");
    const dir = join(root, key);
    const video = join(dir, "run.mp4");
    if (existsSync(video)) {
      rmSync(work, { recursive: true, force: true });
      out.set(g.runId, { runId: g.runId, path: video, frames, cached: true, seconds: 0, blurFrames: comp.blurFrames, peakSigma: comp.peakSigma, compositionDir: dir });
      info(`  ↺ ${g.runId} graphics cached (${g.subject})`);
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(work, dir);
    const lint = await hfLint(dir, { signal: cancellation.signal });
    if (!lint.ok) throw new Error(`${g.runId} composition failed HyperFrames lint: ${JSON.stringify(lint.errors).slice(0, 800)}`);
    stage("graphics", `${g.runId} ${runEntry.layout.replace("lt-", "")}: "${g.subject}" — ${frames} frames @ ${fps} fps (blur on ${comp.blurFrames} frames, peak σ ${comp.peakSigma.toFixed(1)} px)`);
    const t0 = performance.now();
    await hfRender({ dir, output: video, fps: String(comp.renderFps), format: "mp4", quality: draft ? "draft" : "delivery" }, { signal: cancellation.signal });
    const seconds = (performance.now() - t0) / 1000;
    const n = await frameCount(video);
    if (n !== frames * (comp.renderFps / fps)) throw new Error(`${g.runId} graphics rendered ${n} frames, expected ${frames}`);
    out.set(g.runId, { runId: g.runId, path: video, frames, cached: false, seconds, blurFrames: comp.blurFrames, peakSigma: comp.peakSigma, compositionDir: dir });
    notes.push(`${g.runId} graphics: ${frames} frames in ${seconds.toFixed(0)} s (HyperFrames)`);
  }
  return out;
}

async function pieceMedia(p: Project, plan: EditPlan, piece: Piece, src: SourceAsset, notes: string[]): Promise<LtPieceMedia> {
  const frame = flicksPerFrame(plan.output.fps);
  const frames = Math.round((piece.outEnd - piece.outStart) / frame);
  const durS = frames / (plan.output.fps.num / plan.output.fps.den);
  const key = sha(`${src.contentHash}|${piece.srcStart}|${frames}|${plan.output.fps.num}/${plan.output.fps.den}|v1`);
  const dir = join(P.clip(p, plan.clipId), "cache", "lt-matte", key);
  mkdirSync(dir, { recursive: true });
  const clip = join(dir, "clip.mp4");
  const matte = join(dir, "matte.mov");
  const head = piece.slots.find((s) => s.matte);
  const headCrop = head ? plan.cropPaths.find((c) => c.id === head.cropPathId) : null;
  // QA is measured inside the head band, so its cache follows the band geometry.
  const qaPath = join(dir, `qa-${sha(JSON.stringify(headCrop?.keyframes[0]?.box ?? null))}.json`);
  let cached = existsSync(clip);
  if (!cached) {
    // Re-encoded at the source's own rate, starting at the exact frame the card shows;
    // HDR sources are tone mapped here so the card and its matte both see SDR BT.709 frames.
    const v = src.probe.video;
    const tone = v?.isHDR && v.hdrKind ? ["-vf", `${hdrToSdrFilter(await hdrLut(v.hdrKind))},format=yuv420p`] : [];
    await run([tool("ffmpeg"), "-hide_banner", "-nostdin", "-y", "-v", "error", "-ss", flicksToSeconds(piece.srcStart).toFixed(6), "-i", src.localPath, "-t", (durS + 0.1).toFixed(6), "-an", "-map", "0:v:0", ...tone, "-c:v", "libx264", "-preset", "veryfast", "-crf", "8", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", `${clip}.partial.mp4`], { timeoutMs: 1800_000, signal: cancellation.signal });
    renameSync(`${clip}.partial.mp4`, clip);
  }
  if (!head || !headCrop) return { clip, matte: null, qa: null, fallback: null, cached };
  if (!existsSync(matte)) {
    cached = false;
    stage("matte", `remove-background ${durS.toFixed(2)} s of ${src.id} @ ${flicksToSeconds(piece.srcStart).toFixed(2)} s (local u2net_human_seg; ~1.6 s/frame on this CPU)`);
    let last = 0;
    await hfRemoveBackground(clip, `${matte}.partial.mov`, {
      signal: cancellation.signal,
      onProgress: (l) => {
        const m = /Frame (\d+)\/(\d+)/.exec(l);
        if (m && performance.now() - last > 20_000) {
          last = performance.now();
          info(`  matte frame ${m[1]}/${m[2]}`);
        }
      },
    });
    renameSync(`${matte}.partial.mov`, matte);
  }
  let qa: MatteQa;
  if (existsSync(qaPath)) qa = JSON.parse(readFileSync(qaPath, "utf8")) as MatteQa;
  else {
    qa = await py<MatteQa>("matte.check", { matte, clip, box: headCrop.keyframes[0]!.box, iouMin: 0.85, flickerIou: 0.9 });
    writeFileSync(qaPath, JSON.stringify(qa, null, 1));
  }
  const fallback = qa.ok ? null : `contained camera card: ${qa.issues.join("; ")}`;
  notes.push(`matte ${piece.runId} @${flicksToSeconds(piece.outStart).toFixed(2)} s: ${qa.frames} frames, IoU mean ${qa.iouMean} min ${qa.iouMin}, aligned ${qa.alignment?.aligned ?? "n/a"}${fallback ? ` → ${fallback}` : ""}`);
  if (fallback) warn(`  ${piece.runId}: ${fallback}`);
  return { clip, matte: qa.ok ? matte : null, qa, fallback, cached };
}

export async function renderLuxuryLayers(p: Project, plan: EditPlan, sources: Map<string, SourceAsset>, dir: string, opts: { draft?: boolean } = {}): Promise<LuxuryLayers | null> {
  if (!plan.layoutRuns.some((r) => r.layout.startsWith("lt-"))) return null;
  const metrics = JSON.parse(readFileSync(join(paths().fontsDir, "metrics.json"), "utf8")) as MetricsTable;
  const notes: string[] = [];
  const graphics = await renderGraphics(p, plan, metrics, Boolean(opts.draft), notes);
  const media = new Map<number, LtPieceMedia>();
  const ps = pieces(plan);
  for (let i = 0; i < ps.length; i++) {
    const piece = ps[i]!;
    const runEntry = plan.layoutRuns.find((r) => r.id === piece.runId)!;
    if (runEntry.layout !== "lt-split") continue;
    const src = sources.get(piece.sourceId);
    if (!src) throw new Error(`missing source ${piece.sourceId}`);
    media.set(i, await pieceMedia(p, plan, piece, src, notes));
  }
  const masks: LuxuryLayers["masks"] = { card: null, ramp: null };
  const split = plan.layoutRuns.find((r) => r.layout === "lt-split");
  if (split) {
    const card = split.slots.find((s) => s.mask)!;
    const head = split.slots.find((s) => s.matte);
    const r = await py<{ card?: string; ramp?: string }>("matte.masks", {
      card: { region: card.region, rect: card.mask, out: join(dir, "work", "card-mask.png") },
      ...(head ? { ramp: { w: head.region.w, h: head.region.h, y0: head.region.y, featherY: head.matte!.featherY, featherPx: head.matte!.featherPx, out: join(dir, "work", "head-ramp.png") } } : {}),
    });
    masks.card = r.card ?? null;
    masks.ramp = r.ramp ?? null;
  }
  let cover: string | null = null;
  const first = plan.layoutRuns[0]!;
  if (plan.cover?.frameZero && first.layout === "lt-full-camera") {
    const cdir = join(dir, "work", "cover");
    writeCoverComposition(cdir, plan.cover.title, metrics);
    const frames = join(dir, "work", "cover-frames");
    await hfRender({ dir: cdir, output: frames, fps: "60", format: "png-sequence", quality: "delivery" }, { signal: cancellation.signal });
    const png = (await import("node:fs")).readdirSync(frames).filter((f) => f.endsWith(".png")).sort()[0];
    cover = png ? join(frames, png) : null;
    if (!cover) throw new Error("cover overlay render produced no frame");
  }
  let cta: LuxuryLayers["cta"] = null;
  if (plan.cta && plan.cta.showFlicks !== undefined && plan.cta.typeAtFlicks !== undefined && plan.cta.postAtFlicks !== undefined) {
    const show = flicksToSeconds(plan.cta.showFlicks);
    const end = flicksToSeconds(plan.output.durationFlicks);
    const typeAt = flicksToSeconds(plan.cta.typeAtFlicks) - show;
    const typeDur = Math.max(0.5, plan.cta.keyword.length / 12);
    const postAt = flicksToSeconds(plan.cta.postAtFlicks) - show;
    const work = join(dir, "hyperframes", "cta");
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    writeCtaComposition(work, { keyword: plan.cta.keyword, durationS: end - show, typeAtS: typeAt, typeDurS: typeDur, postAtS: postAt, box: { w: plan.cta.box.w, h: plan.cta.box.h } });
    const lint = await hfLint(work, { signal: cancellation.signal });
    if (!lint.ok) throw new Error(`CTA composition failed HyperFrames lint: ${JSON.stringify(lint.errors).slice(0, 600)}`);
    const path = join(dir, "work", "cta.mov");
    stage("graphics", `CTA "${plan.cta.keyword}" overlay (${(end - show).toFixed(2)} s, ProRes 4444 alpha)`);
    await hfRender({ dir: work, output: path, fps: "60", format: "mov", quality: "delivery" }, { signal: cancellation.signal });
    cta = { path, x: plan.cta.box.x - CTA_MARGIN, y: plan.cta.box.y - CTA_MARGIN, startSec: show, endSec: end };
    notes.push(`CTA "${plan.cta.keyword}" (${plan.cta.requestedBy}) typed at ${(show + typeAt).toFixed(2)} s, Post at ${(show + postAt).toFixed(2)} s`);
  }
  return { graphics, pieces: media, masks, cover, cta, notes };
}

/**
 * Luxury layers for re-running QA on an existing render: reads cached matte QA and
 * graphics renders only (never renders). Missing caches leave the related check not-run.
 */
export function cachedLuxuryLayers(p: Project, plan: EditPlan, sources: Map<string, SourceAsset>): LuxuryLayers | null {
  if (!plan.layoutRuns.some((r) => r.layout.startsWith("lt-"))) return null;
  const media = new Map<number, LtPieceMedia>();
  const frame = flicksPerFrame(plan.output.fps);
  pieces(plan).forEach((piece, i) => {
    const run = plan.layoutRuns.find((r) => r.id === piece.runId);
    const src = sources.get(piece.sourceId);
    if (run?.layout !== "lt-split" || !src) return;
    const frames = Math.round((piece.outEnd - piece.outStart) / frame);
    const key = sha(`${src.contentHash}|${piece.srcStart}|${frames}|${plan.output.fps.num}/${plan.output.fps.den}|v1`);
    const dir = join(P.clip(p, plan.clipId), "cache", "lt-matte", key);
    const head = piece.slots.find((s) => s.matte);
    const headCrop = head ? plan.cropPaths.find((c) => c.id === head.cropPathId) : null;
    const qaPath = join(dir, `qa-${sha(JSON.stringify(headCrop?.keyframes[0]?.box ?? null))}.json`);
    if (!existsSync(qaPath)) return;
    const qa = JSON.parse(readFileSync(qaPath, "utf8")) as MatteQa;
    media.set(i, { clip: join(dir, "clip.mp4"), matte: qa.ok ? join(dir, "matte.mov") : null, qa, fallback: qa.ok ? null : `contained camera card: ${qa.issues.join("; ")}`, cached: true });
  });
  return { graphics: new Map(), pieces: media, masks: { card: null, ramp: null }, cover: null, cta: null, notes: [] };
}
