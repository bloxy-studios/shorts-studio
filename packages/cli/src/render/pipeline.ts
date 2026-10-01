import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RenderRecordSchema,
  formatRational,
  toSrt,
  toVtt,
  toWordsJson,
  validatePlan,
  writeJson,
  type CaptionChunk,
  type EditPlan,
  type RenderRecord,
  type SourceAsset,
} from "../../../core/src/index.ts";
import { paths } from "../../../adapters/src/env.ts";
import { loadCaptionStyle } from "../../../adapters/src/presets.ts";
import { planCaptionStates, writeCaptionComposition } from "../../../adapters/src/render/captions.ts";
import { hfLint, hfRender } from "../../../adapters/src/hyperframes.ts";
import { py } from "../../../adapters/src/python.ts";
import { grabFrame } from "../../../adapters/src/media/ffmpeg.ts";
import { hashInputs, cancellation } from "../jobs.ts";
import { P, nowIso, upsertClip, type Project } from "../project.ts";
import { loadPlan, nextRenderId, saveRender } from "../plans.ts";
import { loadSource } from "../commands/ingest.ts";
import { info, stage, warn } from "../ui.ts";
import { renderAudio } from "./audio.ts";
import { renderLuxuryLayers, type LuxuryLayers } from "../luxury/render.ts";
import { composeVideo, makePreview, type Overlay } from "./video.ts";

export interface CaptionBand {
  path: string;
  bandY: number;
  bandHeight: number;
  framesWithCaption: number;
  stateBounds: Array<{ x0: number; y0: number; x1: number; y1: number } | null>;
  states: Array<{ index: number; chunkId: string; activeWordId: string | null; zone: { y0: number; y1: number } }>;
  runs: Array<{ start: number; end: number; frame: { state: number; scale: number; dy: number; opacity: number } }>;
  cached: boolean;
  renderSeconds: number;
}

/** Renders (or reuses) the caption band for a plan. Cache key covers everything that affects pixels. */
export async function renderCaptions(p: Project, plan: EditPlan): Promise<CaptionBand | null> {
  if (!plan.captions || !plan.captions.delivery.burnIn || plan.captions.chunks.length === 0) return null;
  const style = loadCaptionStyle(plan.captions.styleId);
  const zoneFor = (chunk: CaptionChunk) => {
    const run = plan.layoutRuns.find((r) => chunk.outStart >= r.outStart && chunk.outStart < r.outEnd) ?? plan.layoutRuns[0]!;
    return run.captionZone;
  };
  const statePlan = planCaptionStates(plan.captions, style, zoneFor, plan.output.fps, plan.output.frameCount);
  const metricsHash = hashInputs({ m: readFileSync(join(paths().fontsDir, "metrics.json"), "utf8") });
  const key = hashInputs({ captions: JSON.stringify(plan.captions), runs: JSON.stringify(statePlan.runs), states: JSON.stringify(statePlan.states), style: JSON.stringify(style), canvas: `${plan.output.width}x${plan.output.height}`, fps: formatRational(plan.output.fps), metricsHash, v: "2" });
  const dir = join(P.clip(p, plan.clipId), "cache", "captions", key);
  const bandPath = join(dir, "band.mov");
  const metaPath = join(dir, "band.json");
  if (existsSync(bandPath) && existsSync(metaPath)) {
    info(`  ↺ captions: cached band (${statePlan.states.length} states)`);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Omit<CaptionBand, "cached" | "states" | "runs">;
    return { ...meta, states: statePlan.states, runs: statePlan.runs, cached: true };
  }
  mkdirSync(dir, { recursive: true });
  const comp = writeCaptionComposition(join(dir, "composition"), statePlan, plan.captions, style, { width: plan.output.width, height: plan.output.height });
  stage("captions", `HyperFrames lint (${comp.stateCount} caption states, style ${style.id})`);
  const lint = await hfLint(comp.dir, { signal: cancellation.signal });
  if (!lint.ok) throw new Error(`caption composition failed HyperFrames lint: ${JSON.stringify(lint.errors).slice(0, 800)}`);
  stage("captions", `HyperFrames render: ${comp.stateCount} state frame(s) (one per distinct caption state)`);
  const started = performance.now();
  const framesDir = join(dir, "frames");
  rmSync(framesDir, { recursive: true, force: true });
  await hfRender({ dir: comp.dir, output: framesDir, fps: String(comp.fps), format: "png-sequence", quality: "looks" }, { signal: cancellation.signal });
  const renderSeconds = (performance.now() - started) / 1000;
  stage("captions", `compositing frame-exact band over ${plan.output.frameCount} frames`);
  const band = await py<{ path: string; bandY: number; bandHeight: number; framesWithCaption: number; stateBounds: CaptionBand["stateBounds"] }>("render.caption_band", {
    framesDir,
    runs: statePlan.runs,
    frameCount: plan.output.frameCount,
    fpsNum: plan.output.fps.num,
    fpsDen: plan.output.fps.den,
    out: bandPath,
    width: plan.output.width,
    height: plan.output.height,
  });
  const meta = { path: band.path, bandY: band.bandY, bandHeight: band.bandHeight, framesWithCaption: band.framesWithCaption, stateBounds: band.stateBounds, renderSeconds };
  writeFileSync(metaPath, JSON.stringify(meta));
  return { ...meta, states: statePlan.states, runs: statePlan.runs, cached: false };
}

export interface RenderOptions {
  draft?: boolean;
  planVersion?: number;
}

export interface RenderOutcome {
  record: RenderRecord;
  plan: EditPlan;
  captions: CaptionBand | null;
  dir: string;
  sources: Map<string, SourceAsset>;
  luxury: LuxuryLayers | null;
}

export async function renderClip(p: Project, clipId: string, opts: RenderOptions = {}): Promise<RenderOutcome> {
  const plan = loadPlan(p, clipId, opts.planVersion);
  const sources = new Map(plan.sources.map((s) => [s.sourceId, loadSource(p, s.sourceId)]));
  const frames = new Map(
    [...sources.values()].filter((s) => s.probe.video).map((s) => [s.id, { width: s.probe.video!.displayWidth, height: s.probe.video!.displayHeight, durationFlicks: s.probe.durationFlicks }]),
  );
  const issues = validatePlan(plan, { sourceFrames: frames });
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) throw new Error(`plan v${plan.version} is invalid:\n${errors.map((e) => `  ${e.code}: ${e.message}`).join("\n")}`);

  const renderId = nextRenderId(p, clipId);
  const dir = P.render(p, clipId, renderId);
  mkdirSync(join(dir, "work"), { recursive: true });
  const timings: Record<string, number> = {};
  const t0 = performance.now();
  let record: RenderRecord = RenderRecordSchema.parse({
    schemaVersion: 1,
    id: renderId,
    clipId,
    planVersion: plan.version,
    kind: opts.draft ? "draft" : "final",
    status: "rendering",
    createdAt: nowIso(),
    profile: {
      width: plan.output.width,
      height: plan.output.height,
      fps: formatRational(plan.output.fps),
      videoCodec: "h264",
      pixFmt: plan.output.video.pixFmt,
      crf: opts.draft ? 23 : plan.output.video.crf,
      audioCodec: "aac",
      sampleRate: plan.output.sampleRate,
      audioChannels: plan.output.audioChannels,
    },
    paths: {},
  });
  saveRender(p, record);
  info(`render ${clipId}/${renderId} (plan v${plan.version}, ${(plan.output.durationFlicks / 705_600_000).toFixed(2)} s, ${plan.output.frameCount} frames @ ${formatRational(plan.output.fps)} fps)`);

  try {
    // 1. Captions (cached by content).
    let t = performance.now();
    const captions = await renderCaptions(p, plan);
    timings.captionsSec = (performance.now() - t) / 1000;

    // 2. Audio stems + master.
    t = performance.now();
    const audio = await renderAudio(plan, sources, dir);
    timings.audioSec = (performance.now() - t) / 1000;
    for (const l of audio.log) info(`  ℹ ${l}`);

    // 3. Luxury Tech layers (graphics per run, aligned head mattes, cover) when the plan uses them.
    t = performance.now();
    const luxury = await renderLuxuryLayers(p, plan, sources, dir, { draft: Boolean(opts.draft) });
    if (luxury) timings.graphicsSec = (performance.now() - t) / 1000;

    // 4. Video composite + encode.
    t = performance.now();
    const overlays: Overlay[] = [];
    if (captions) overlays.push({ path: captions.path, x: 0, y: captions.bandY });
    if (luxury?.cta) overlays.push({ path: luxury.cta.path, x: luxury.cta.x, y: luxury.cta.y, inputArgs: ["-itsoffset", luxury.cta.startSec.toFixed(6)], enable: `gte(t,${luxury.cta.startSec.toFixed(6)})` });
    if (luxury?.cover) overlays.push({ path: luxury.cover, x: 0, y: 0, inputArgs: ["-loop", "1", "-framerate", formatRational(plan.output.fps), "-t", (plan.output.fps.den / plan.output.fps.num).toFixed(6)], enable: "eq(n,0)" });
    const finalPath = join(dir, `${p.config.id}_${clipId}_v${plan.version}_${renderId}.mp4`);
    await composeVideo({ plan, sources, overlays, audioPath: audio.masterPath, output: finalPath, draft: Boolean(opts.draft), luxury });
    timings.videoSec = (performance.now() - t) / 1000;

    // 5. Deliverables.
    stage("export", "preview, cover, subtitles, plan copy");
    const previewPath = join(dir, "preview_540x960.mp4");
    await makePreview(finalPath, previewPath);
    const coverPath = join(dir, "cover.jpg");
    await grabFrame(finalPath, 0, coverPath);
    const paths_: Record<string, string> = { video: finalPath, preview: previewPath, cover: coverPath, master: audio.masterPath, plan: join(dir, "editplan.json") };
    copyFileSync(join(P.plans(p, clipId), `editplan-v${String(plan.version).padStart(3, "0")}.json`), paths_.plan!);
    if (plan.captions) {
      const base = join(dir, "captions");
      if (plan.captions.delivery.srt) writeFileSync((paths_.srt = `${base}.srt`), toSrt(plan.captions));
      if (plan.captions.delivery.vtt) writeFileSync((paths_.vtt = `${base}.vtt`), toVtt(plan.captions));
      if (plan.captions.delivery.wordsJson) writeJson((paths_.wordsJson = `${base}.words.json`), toWordsJson(plan.captions));
    }
    for (const [k, v] of Object.entries(audio.stems)) paths_[`stem_${k}`] = v.path;
    // Editable HyperFrames sources behind this render (exported with the package).
    for (const [runId, g] of luxury?.graphics ?? []) paths_[`hf_${runId}`] = g.compositionDir;
    if (luxury?.cta) paths_.hf_cta = join(dir, "hyperframes", "cta");
    timings.totalSec = (performance.now() - t0) / 1000;
    record = RenderRecordSchema.parse({
      ...record,
      status: "done",
      finishedAt: nowIso(),
      paths: paths_,
      stems: audio.stems,
      master: audio.master,
      timings,
      notes: [...audio.log, ...(captions ? [`captions: ${captions.states.length} states, band y=${captions.bandY} h=${captions.bandHeight}${captions.cached ? " (cached)" : `, HyperFrames ${captions.renderSeconds.toFixed(0)} s`}`] : []), ...(luxury?.notes ?? [])],
    });
    saveRender(p, record);
    upsertClip(p, { id: clipId, latestRenderId: renderId });
    rmSync(join(dir, "work"), { recursive: true, force: true });
    info(`  ✓ ${finalPath} (${timings.totalSec.toFixed(0)} s total)`);
    return { record, plan, captions, dir, sources, luxury };
  } catch (e) {
    record = { ...record, status: cancellation.signal.aborted ? "failed" : "failed", finishedAt: nowIso(), notes: [...record.notes, `failed: ${(e as Error).message.slice(0, 500)}`] };
    saveRender(p, record);
    warn(`render ${renderId} failed; partial files kept in ${dir}`);
    throw e;
  }
}
