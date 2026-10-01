import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CaptionTrackSchema,
  TimeMap,
  applyEmphasis,
  buildTimeMapPieces,
  flicksPerFrame,
  flicksToSeconds,
  formatTimecode,
  groupCaptions,
  makeMeasurer,
  parseTimecode,
  quantizeToFrame,
  rational,
  retimeWords,
  type CaptionStyle,
  type CaptionTrack,
  type MetricsTable,
} from "../../../core/src/index.ts";
import { loadCaptionStyle, listIds, loadPreset } from "../../../adapters/src/presets.ts";
import { planCaptionStates, wordSpacingPx, writeCaptionComposition } from "../../../adapters/src/render/captions.ts";
import { hfLint, hfRender } from "../../../adapters/src/hyperframes.ts";
import { paths } from "../../../adapters/src/env.ts";
import { py } from "../../../adapters/src/python.ts";
import { run } from "../../../adapters/src/proc.ts";
import { tool } from "../../../adapters/src/tools.ts";
import type { Command } from "../registry.ts";
import { loadProject, type Project } from "../project.ts";
import { stage } from "../ui.ts";
import { defaultSource, loadSource } from "./ingest.ts";
import { loadTranscript } from "./transcribe.ts";
import { loadVisual } from "./analyze.ts";
import { staticFaceCrop } from "../plan/clip.ts";

export interface CaptionPreviewResult {
  dir: string;
  sheet: string;
  samples: Array<{ styleId: string; name: string; video: string; still: string; states: number }>;
  range: { start: number; end: number };
}

/** Builds the caption track a style would produce for the excerpt (same grouping/emphasis rules as the planner). */
function trackFor(style: CaptionStyle, words: ReturnType<typeof retimeWords>["words"], endFlicks: number, metrics: MetricsTable, fps: ReturnType<typeof rational>): CaptionTrack {
  const measure = makeMeasurer(metrics, {
    family: style.base.family,
    weight: style.base.weight,
    style: style.base.style,
    sizePx: style.base.sizePx,
    letterSpacingEm: style.base.letterSpacingEm,
    strokePx: style.base.stroke?.widthPx ?? 0,
    upper: style.base.case === "upper",
    wordSpacingPx: wordSpacingPx(style),
  });
  const { chunks } = groupCaptions(words, style.grouping, { fps, minStart: flicksPerFrame(fps), end: endFlicks, measure, maxWidthPx: style.placement.maxWidthPx, caseMode: style.base.case });
  const emph = applyEmphasis(chunks, { mode: style.emphasis.mode, maxWordsPerChunk: style.emphasis.maxWordsPerChunk, ...(style.emphasis.cadence ? { cadence: style.emphasis.cadence } : {}) });
  return CaptionTrackSchema.parse({ styleId: style.id, styleVersion: style.version, overrides: {}, language: "en", chunks: emph.chunks, delivery: { burnIn: true, srt: false, vtt: false, wordsJson: false }, minStartFlicks: flicksPerFrame(fps), notes: [] });
}

/**
 * Renders the SAME 5–8 s excerpt in every caption style: a short playable sample per
 * style plus one comparison sheet with a representative frame of each, so the user
 * chooses from pictures, not names.
 */
export async function previewCaptions(p: Project, opts: { sourceId?: string; start: number; end: number; styles?: string[] }): Promise<CaptionPreviewResult> {
  const src = opts.sourceId ? loadSource(p, opts.sourceId) : defaultSource(p);
  const transcript = loadTranscript(p, src.id);
  if (!transcript) throw new Error("transcribe the source first");
  const v = src.probe.video;
  if (!v || !src.derived.audio48k) throw new Error("caption previews need a source with video and audio");
  const preset = loadPreset(p.config.presetId);
  const fps = rational(30);
  const frame = flicksPerFrame(fps);
  const start = quantizeToFrame(opts.start, fps, "floor");
  const end = quantizeToFrame(opts.end, fps, "ceil");
  const dur = end - start;
  const map = new TimeMap(buildTimeMapPieces([{ id: "seg", picture: { sourceId: src.id, srcStart: start, outStart: 0, outEnd: dur, rate: { num: 1, den: 1 } }, audio: [{ id: "a", sourceId: src.id, srcStart: start, outStart: 0, outEnd: dur, fadeInFlicks: 0, fadeOutFlicks: 0, gainDb: 0, role: "source-mix" }], wordIds: [] }]));
  const words = retimeWords(transcript.words, map, src.id).words;
  if (words.length < 3) throw new Error("the preview range contains too few words; choose a range with continuous speech");
  const metrics = JSON.parse(await Bun.file(join(paths().fontsDir, "metrics.json")).text()) as MetricsTable;
  const dir = join(p.dir, "review", "captions", `${formatTimecode(start).replace(/[:.]/g, "")}-${formatTimecode(end).replace(/[:.]/g, "")}`);
  mkdirSync(dir, { recursive: true });

  // One static, face-centred base clip shared by every style (same footage for a fair comparison).
  const visual = loadVisual(p, src.id);
  const track = visual?.faceTracks.filter((t) => t.samples.some((s) => s.t >= start && s.t < end)).sort((a, b) => b.samples.length - a.samples.length)[0] ?? null;
  const crop = staticFaceCrop(v.displayWidth, v.displayHeight, 1080 / 1920, track, start, end, preset.framing.headroomFrac, preset.framing.eyeLineFrac).box;
  const base = join(dir, "base.mp4");
  stage("preview", `base excerpt ${formatTimecode(start)}–${formatTimecode(end)} (${flicksToSeconds(dur).toFixed(1)} s)`);
  await run([
    tool("ffmpeg"), "-hide_banner", "-nostdin", "-y", "-v", "error",
    "-ss", flicksToSeconds(start).toFixed(4), "-t", flicksToSeconds(dur).toFixed(4), "-i", src.localPath,
    "-ss", flicksToSeconds(start).toFixed(4), "-t", flicksToSeconds(dur).toFixed(4), "-i", src.derived.audio48k.path,
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", `fps=30,crop=${Math.round(crop.w / 2) * 2}:${Math.round(crop.h / 2) * 2}:${Math.round(crop.x)}:${Math.round(crop.y)},scale=1080:1920:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "128k", base,
  ], { timeoutMs: 1800_000 });

  const styles = opts.styles?.length ? opts.styles : listIds("captions");
  const frameCount = Math.round(dur / frame);
  const samples: CaptionPreviewResult["samples"] = [];
  for (const id of styles) {
    const style = loadCaptionStyle(id);
    const capTrack = trackFor(style, words, dur, metrics, fps);
    const zone = preset.captions.zones["full-crop"] ?? style.placement.zone;
    const plan = planCaptionStates(capTrack, style, () => zone, fps, frameCount);
    const sdir = join(dir, id);
    const comp = writeCaptionComposition(join(sdir, "composition"), plan, capTrack, style, { width: 1080, height: 1920 });
    stage("preview", `${style.name}: ${comp.stateCount} caption state(s)`);
    const lint = await hfLint(comp.dir);
    if (!lint.ok) throw new Error(`${id} composition failed lint: ${JSON.stringify(lint.errors).slice(0, 400)}`);
    const framesDir = join(sdir, "frames");
    await hfRender({ dir: comp.dir, output: framesDir, fps: String(comp.fps), format: "png-sequence", quality: "looks" });
    const band = await py<{ path: string; bandY: number }>("render.caption_band", { framesDir, runs: plan.runs, frameCount, fpsNum: fps.num, fpsDen: fps.den, out: join(sdir, "band.mov"), width: 1080, height: 1920 });
    const video = join(sdir, `${id}.mp4`);
    await run([
      tool("ffmpeg"), "-hide_banner", "-nostdin", "-y", "-v", "error", "-i", base, "-i", band.path,
      "-filter_complex", `[0:v][1:v]overlay=x=0:y=${band.bandY}:format=auto:eof_action=pass,format=yuv420p[v]`,
      "-map", "[v]", "-map", "0:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "copy", "-frames:v", String(frameCount), video,
    ], { timeoutMs: 1800_000 });
    // Representative still: the first chunk with emphasis if any, else the middle chunk.
    const showChunk = capTrack.chunks.find((c) => c.words.some((w) => w.emphasis === "highlight")) ?? capTrack.chunks[Math.floor(capTrack.chunks.length / 2)]!;
    const t = flicksToSeconds(showChunk.outStart + Math.min(showChunk.outEnd - showChunk.outStart, frame * 6));
    const still = join(sdir, `${id}.jpg`);
    await run([tool("ffmpeg"), "-hide_banner", "-nostdin", "-y", "-v", "error", "-ss", t.toFixed(4), "-i", video, "-frames:v", "1", "-q:v", "3", still]);
    samples.push({ styleId: id, name: style.name, video, still, states: comp.stateCount });
  }

  // Comparison sheet (PIL via the sheet helper is source-based, so compose stills directly).
  const sheet = join(dir, "caption-styles.jpg");
  await py("preview.compose", { stills: samples.map((s) => s.still), labels: samples.map((s) => `${s.name} (${s.styleId})`), out: sheet, title: `Caption styles on the same ${flicksToSeconds(dur).toFixed(1)} s excerpt (${formatTimecode(start)}–${formatTimecode(end)})`, fontPath: join(paths().fontsDir, "Inter-Variable.ttf") });
  writeFileSync(join(dir, "index.json"), JSON.stringify({ range: { start, end }, samples }, null, 2));
  return { dir, sheet, samples, range: { start, end } };
}

export const previewCommands: Record<string, Command> = {
  preview: {
    summary: "Visual style previews: `preview captions` renders one excerpt in every caption style + a comparison sheet",
    usage: "shorts-studio preview captions <project> --range START-END [--source ID] [--styles clean,bold-pop,...]",
    async run(args) {
      const sub = args.pos(0, "captions");
      if (sub !== "captions") throw new Error(`unknown preview type ${sub} (supported: captions)`);
      const p = loadProject(args.pos(1, "project"));
      const m = /^\s*([^-–]+?)\s*[-–]\s*([^-–]+?)\s*$/.exec(args.req("range"));
      if (!m) throw new Error("--range expects START-END");
      const res = await previewCaptions(p, {
        ...(args.str("source") ? { sourceId: args.str("source")! } : {}),
        start: parseTimecode(m[1]!),
        end: parseTimecode(m[2]!),
        ...(args.str("styles") ? { styles: args.str("styles")!.split(",").map((s) => s.trim()) } : {}),
      });
      return { json: res, human: [`comparison sheet: ${res.sheet}`, ...res.samples.map((s) => `  ${s.name.padEnd(15)} ${s.video}`)].join("\n") };
    },
  },
};
