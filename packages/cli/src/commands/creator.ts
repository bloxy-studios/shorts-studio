import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CaptionTrackSchema,
  EditPlanSchema,
  buildTimeMapPieces,
  computeExtent,
  flicksPerFrame,
  flicksToSeconds,
  formatTimecode,
  normalizeToken,
  secondsToFlicks,
  validatePlan,
  writeJson,
  type EditPlan,
  type MetricsTable,
  type SourceAsset,
  type SourceClock,
  type Transcript,
} from "../../../core/src/index.ts";
import { detectTakes } from "../../../core/src/takes/detect.ts";
import { loadCaptionStyle, loadPreset } from "../../../adapters/src/presets.ts";
import { paths } from "../../../adapters/src/env.ts";
import { py } from "../../../adapters/src/python.ts";
import type { Command } from "../registry.ts";
import { P, loadProject, nowIso, upsertClip, type Project } from "../project.ts";
import { savePlan, nextPlanVersion } from "../plans.ts";
import { assembleCreator, wordsForSegments, type LineEndpoint } from "../plan/creator.ts";
import { planFraming } from "../plan/framing.ts";
import { recaption } from "../revise/ops.ts";
import { ingest } from "./ingest.ts";
import { transcribe } from "./transcribe.ts";
import { ensureAudioFeatures, loadVisual, analyze } from "./analyze.ts";
import { info, stage, warn } from "../ui.ts";

interface SyncResult {
  status: "confirmed" | "probable" | "unreliable";
  method: string;
  offsetS: number;
  driftPpm: number;
  confidence: number;
  residualMs: number | null;
  windows: unknown[];
  spotChecks: Array<{ t: number; ok: boolean; status?: "ok" | "mismatch" | "inconclusive" | "outside"; residualMs?: number; psr?: number }>;
  reason?: string;
}

/** Alternate alignment when cross-correlation is unreliable: matching word trigrams. */
function transcriptAlignment(cam: Transcript, mic: Transcript): { offsetS: number; matches: number; spreadMs: number } | null {
  const key = (ws: Transcript["words"], i: number) => ws.slice(i, i + 3).map((w) => normalizeToken(w.text)).join(" ");
  const camIndex = new Map<string, number[]>();
  for (let i = 0; i + 3 <= cam.words.length; i++) camIndex.set(key(cam.words, i), [...(camIndex.get(key(cam.words, i)) ?? []), i]);
  const offsets: number[] = [];
  for (let j = 0; j + 3 <= mic.words.length; j++) {
    const hits = camIndex.get(key(mic.words, j));
    if (hits?.length === 1) offsets.push(flicksToSeconds(mic.words[j]!.start - cam.words[hits[0]!]!.start));
  }
  if (offsets.length < 5) return null;
  offsets.sort((a, b) => a - b);
  const med = offsets[Math.floor(offsets.length / 2)]!;
  const inliers = offsets.filter((o) => Math.abs(o - med) < 0.15);
  const spread = inliers.length ? (inliers[inliers.length - 1]! - inliers[0]!) * 1000 : 9999;
  return { offsetS: inliers.reduce((a, b) => a + b, 0) / inliers.length, matches: inliers.length, spreadMs: spread };
}

export interface CreatorOptions {
  camera: string;
  mic: string;
  presetId?: string;
  styleId?: string;
  title?: string;
  clipId?: string;
  language?: string;
  keywords?: string[];
}

export async function creatorPlan(p: Project, opts: CreatorOptions): Promise<{ plan: EditPlan; report: string; sync: SyncResult }> {
  stage("creator", "ingest camera + clean mic");
  const [camera] = await ingest(p, [opts.camera], { role: "camera" });
  const [mic] = await ingest(p, [opts.mic], { role: "mic" });
  if (!camera?.probe.video) throw new Error("--camera must be a video file");
  if (!mic?.derived.audio48k) throw new Error("--mic must contain audio");
  const preset = loadPreset(opts.presetId ?? p.config.presetId);
  const language = opts.language ?? p.config.language ?? "en";
  const micT = await transcribe(p, { sourceId: mic.id, language });
  await ensureAudioFeatures(p, mic);
  await analyze(p, { sourceId: camera.id });

  // 1. Camera ↔ mic alignment with evidence.
  stage("creator", "aligning clean mic to the camera (windowed GCC-PHAT + drift fit)");
  let sync = await py<SyncResult>("audio.sync", { camera: camera.localPath, mic: mic.localPath, maxOffsetS: 60, windowS: 10, windows: 10 });
  if (sync.status === "unreliable") {
    warn(`cross-correlation unreliable (${sync.reason ?? "weak peaks"}); trying transcript alignment`);
    const camT = await transcribe(p, { sourceId: camera.id, language, model: "base.en" });
    const alt = transcriptAlignment(camT, micT);
    if (!alt || alt.spreadMs > 120) throw new Error(`could not align the mic to the camera with evidence (correlation: ${sync.reason}; transcript: ${alt ? `${alt.matches} matches, spread ${alt.spreadMs.toFixed(0)} ms` : "too few matching phrases"}). Check that both files record the same session.`);
    sync = { ...sync, status: "probable", method: "transcript-trigram-alignment", offsetS: alt.offsetS, driftPpm: 0, confidence: Math.min(0.7, alt.matches / 40), residualMs: alt.spreadMs / 2, reason: `${alt.matches} matching word trigrams` };
  }
  writeJson(join(P.analysis(p, camera.id), "sync.json"), sync);
  info(`  ✓ mic = camera + ${sync.offsetS.toFixed(4)} s, drift ${sync.driftPpm.toFixed(1)} ppm (${sync.status}, confidence ${sync.confidence}, residual ${sync.residualMs?.toFixed(2) ?? "n/a"} ms)`);
  const clock: SourceClock = {
    refSourceId: camera.id,
    offsetFlicks: secondsToFlicks(sync.offsetS),
    driftPpm: sync.driftPpm,
    anchorFlicks: 0,
    confidence: sync.confidence,
    method: sync.method,
    evidence: `${sync.status}; residual ${sync.residualMs?.toFixed(2) ?? "n/a"} ms; spot checks ${sync.spotChecks.filter((c) => c.ok).length}/${sync.spotChecks.length} ok${sync.spotChecks.some((c) => c.status === "inconclusive") ? `, ${sync.spotChecks.filter((c) => c.status === "inconclusive").length} inconclusive` : ""}`,
  };

  // 2. Takes.
  stage("creator", "detecting repeated takes (last complete take; earlier only for audible defects)");
  const takes = detectTakes(micT.words);
  // 3. Measured line boundaries on the clean mic.
  const words = micT.words;
  const lines = takes.lines.map((l) => {
    const ws = l.chosen.sentence.words;
    const firstIdx = words.indexOf(ws[0]!);
    const lastIdx = words.indexOf(ws[ws.length - 1]!);
    return {
      id: l.id,
      firstWordStartS: flicksToSeconds(ws[0]!.start),
      lastWordEndS: flicksToSeconds(ws[ws.length - 1]!.end),
      ...(firstIdx > 0 ? { prevSoundEndS: flicksToSeconds(words[firstIdx - 1]!.end) } : {}),
      ...(lastIdx >= 0 && lastIdx + 1 < words.length ? { nextSoundStartS: flicksToSeconds(words[lastIdx + 1]!.start) } : {}),
    };
  });
  const ep = await py<{ lines: Array<{ id: string; start: { startS: number }; end: { endS: number; deviation: string | null }; quiet: Array<{ startS: number; endS: number; ms: number }> }> }>("audio.endpoints", {
    wav: mic.derived.audio48k.path,
    lines,
    endDb: -35,
    sustainDb: -32,
    sustainMs: 150,
    quietDb: -45,
    quietMinMs: 100,
  });
  const endpoints: LineEndpoint[] = ep.lines.map((l) => ({ id: l.id, startS: l.start.startS, endS: l.end.endS, quiet: l.quiet, deviation: l.end.deviation }));

  // 4. Assemble.
  const fps = preset.output.fpsPolicy === "fixed" && preset.output.fps ? preset.output.fps : { num: 30, den: 1 };
  const asm = assembleCreator({
    camera,
    mic,
    clock,
    takes,
    endpoints,
    fps,
    rules: {
      preRollMs: preset.pacing.preRollMs,
      compressAboveMs: preset.pacing.silenceCompress?.aboveMs ?? 250,
      compressToMs: preset.pacing.silenceCompress?.toMs ?? 120,
      jCutLeadMs: preset.pacing.jCut.enabled ? preset.pacing.jCut.leadMs : 0,
      tailFadeMaxMs: preset.pacing.tailFadeMaxMs || 170,
      joinGapMs: Math.min(preset.pacing.silenceCompress?.toMs ?? 120, preset.pacing.maxQuietJoinMs),
    },
  });
  const segments = wordsForSegments(micT, asm.segments);
  const blacks = loadVisual(p, camera.id)?.blackIntervals ?? [];
  for (const seg of segments) {
    const a = seg.picture.srcStart;
    const b = a + (seg.picture.outEnd - seg.picture.outStart);
    const hit = blacks.find((x) => x.start < b && x.end > a);
    if (hit) asm.deviations.push(`${seg.lineId ?? seg.id}: camera picture is black ${formatTimecode(hit.start)}–${formatTimecode(hit.end)} (source gap) — needs a visual/graphic or another take`);
  }
  const extent = computeExtent(segments, fps);
  segments[segments.length - 1]!.picture.outEnd = extent.end;
  const W = preset.output.width;
  const H = preset.output.height;
  const visual = loadVisual(p, camera.id);
  const timeMap = buildTimeMapPieces(segments);
  const spans = segments.map((s, i) => ({ start: s.picture.outStart, end: s.picture.outEnd, punchIn: preset.framing.punchIn && i % 2 === 1 ? Math.max(preset.framing.punchIn.min, 1.06) : 1, reason: i === 0 ? "opening line" : `take join (${s.note ?? "hard cut"})` }));
  const { TimeMap } = await import("../../../core/src/index.ts");
  const framing = planFraming({
    preset,
    sourceId: camera.id,
    frame: { width: camera.probe.video.displayWidth, height: camera.probe.video.displayHeight },
    canvas: { width: W, height: H },
    fps,
    map: new TimeMap(timeMap),
    tracks: visual?.faceTracks ?? [],
    speech: [],
    spans,
  });
  const style = loadCaptionStyle(opts.styleId ?? p.config.captionStyleId ?? preset.captions.defaultStyleId);
  const clipId = opts.clipId ?? "creator-edit";
  const metrics = JSON.parse(readFileSync(join(paths().fontsDir, "metrics.json"), "utf8")) as MetricsTable;
  const frame = flicksPerFrame(fps);
  let plan: EditPlan = EditPlanSchema.parse({
    schemaVersion: 1,
    projectId: p.config.id,
    clipId,
    version: nextPlanVersion(p, clipId),
    parentVersion: null,
    createdAt: nowIso(),
    createdBy: "creator-edit",
    changeSummary: `creator edit: ${takes.lines.length} line(s), ${takes.lines.filter((l) => l.swappedFromLast).length} earlier-take swap(s)`,
    changes: [],
    presetId: preset.id,
    presetVersion: preset.version,
    output: {
      width: W,
      height: H,
      fps,
      sampleRate: 48_000,
      audioChannels: 2,
      durationFlicks: extent.end,
      voiceEndFlicks: extent.voiceEnd,
      frameCount: extent.frameCount,
      video: { codec: "h264", pixFmt: "yuv420p", crf: preset.output.crf, preset: preset.output.x264Preset, profile: "high" },
      audio: { codec: "aac", bitrateKbps: 192 },
    },
    sources: asm.sources,
    segments,
    timeMap,
    layoutRuns: framing.layoutRuns,
    cropPaths: framing.cropPaths,
    captions: CaptionTrackSchema.parse({ styleId: style.id, styleVersion: style.version, overrides: {}, language: micT.language, chunks: [], delivery: { burnIn: true, srt: true, vtt: true, wordsJson: true }, minStartFlicks: preset.captions.startAfterFirstFrame ? frame : 0, notes: [] }),
    audio: {
      sourceAudioPolicy: "voice-only",
      voice: { sourceId: mic.id, chain: { ...preset.audio.voiceChain, targetLufs: preset.audio.voiceTargetLufs } },
      music: { mode: "none", seed: 1, bpm: 110, key: "C", targetLufs: null, fadeOutFlicks: 0, declickFlicks: 0, ducking: false, gainDb: 0, params: {} },
      sfx: [],
      riser: null,
      master: { targetLufs: preset.audio.masterTargetLufs, maxTruePeakDbtp: preset.audio.maxTruePeakDbtp, limiter: "if-needed" },
    },
    cover: opts.title ? { title: opts.title, titleSource: "user", frameZero: preset.id === "luxury-tech", style: preset.cover.style, exportImage: true } : null,
    takes: takes.choices,
    decisions: [
      { key: "voice", value: mic.id, layer: "default", reason: "clean mic used as the voice once alignment was verified" },
      { key: "takes", value: "last-complete", layer: "preset", reason: "creator workflow default; earlier take only for audible defects" },
    ],
    fallbacks: sync.method.startsWith("transcript") ? [{ capability: "audio cross-correlation sync", reason: sync.reason ?? "weak correlation peaks", fallback: "transcript trigram alignment" }] : [],
  });
  plan = recaption(plan, { transcript: micT, visual, frame: { width: camera.probe.video.displayWidth, height: camera.probe.video.displayHeight, durationFlicks: camera.probe.durationFlicks }, styleFor: (id) => loadCaptionStyle(id), metrics, zoneFor: (layout) => preset.captions.zones[layout] ?? { y0: 1180, y1: 1460 } }, style.id, { keywords: opts.keywords ?? [], onlyKeywords: false });
  const issues = validatePlan(plan, { sourceFrames: new Map([[camera.id, { width: camera.probe.video.displayWidth, height: camera.probe.video.displayHeight, durationFlicks: camera.probe.durationFlicks }]]), sourceWordIds: new Set(micT.words.map((w) => w.id)) });
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length) throw new Error(`creator plan invalid:\n${errors.map((e) => `  ${e.code}: ${e.message}`).join("\n")}`);
  upsertClip(p, { id: clipId, kind: "creator-edit", ...(opts.title ? { title: opts.title } : {}) });
  savePlan(p, plan);

  // 5. Readable creator report: sync evidence and every take decision.
  const reportLines = [
    `# Creator edit — ${clipId} plan v${plan.version}`,
    "",
    "## Alignment",
    `- mic time = camera time + ${sync.offsetS.toFixed(4)} s ${sync.driftPpm ? `+ ${sync.driftPpm.toFixed(1)} ppm drift` : "(no significant drift)"}`,
    `- status ${sync.status}, method ${sync.method}, confidence ${sync.confidence}, residual ${sync.residualMs?.toFixed(2) ?? "n/a"} ms`,
    `- spot checks: ${sync.spotChecks.map((c) => `${c.t.toFixed(1)} s ${c.status === "inconclusive" ? "inconclusive (weak peak, PSR " + (c.psr ?? "?") + ")" : c.status === "mismatch" ? "MISMATCH" : c.ok ? "ok" : (c.status ?? "FAIL")} (${c.residualMs ?? "?"} ms)`).join("; ") || "none"}`,
    "",
    "## Takes",
    ...takes.lines.map((l) => `- ${l.id}: chose ${l.chosen.id} "${l.chosen.sentence.text}" — ${l.reason}${l.swappedFromLast ? `; rejected last take said: "${l.takes[l.takes.length - 1]!.sentence.text}"` : ""}`),
    "",
    "## Removed",
    ...takes.removed.map((r) => `- ${formatTimecode(r.start)} ${r.kind}: "${r.text}" (${r.reason})`),
    "",
    "## Cut rules applied",
    ...asm.notes.map((n) => `- ${n}`),
    ...asm.deviations.map((d) => `- deviation: ${d}`),
    `- END ${(flicksToSeconds(plan.output.durationFlicks) * 1000).toFixed(1)} ms = ${plan.output.frameCount} frames; last voice sample at ${(flicksToSeconds(plan.output.voiceEndFlicks) * 1000).toFixed(1)} ms`,
  ];
  const report = join(P.clip(p, clipId), "creator-report.md");
  mkdirSync(P.clip(p, clipId), { recursive: true });
  writeFileSync(report, `${reportLines.join("\n")}\n`);
  return { plan, report, sync };
}

export const creatorCommands: Record<string, Command> = {
  creator: {
    summary: "Creator Edit: camera + clean mic → aligned voice, selected takes, J-cuts, finished short (edit/final.mp4)",
    usage: "shorts-studio creator <project> --camera FILE --mic FILE [--preset ID] [--style ID] [--title TEXT] [--brief graphics.json] [--keyword TERM]... [--language en] [--render]",
    async run(args) {
      const p = loadProject(args.pos(0, "project"));
      const res = await creatorPlan(p, {
        camera: args.req("camera"),
        mic: args.req("mic"),
        ...(args.str("preset") ? { presetId: args.str("preset")! } : {}),
        ...(args.str("style") ? { styleId: args.str("style")! } : {}),
        ...(args.str("title") ? { title: args.str("title")! } : {}),
        ...(args.str("language") ? { language: args.str("language")! } : {}),
        keywords: args.all("keyword"),
      });
      if ((args.str("preset") ?? p.config.presetId) === "luxury-tech") {
        const { applyLuxury } = await import("./luxury.ts");
        const lux = applyLuxury(p, res.plan.clipId, { ...(args.str("brief") ? { brief: args.str("brief")! } : {}), ...(args.str("title") ? { title: args.str("title")! } : {}) });
        res.plan = lux.plan;
        info(`  ✓ Luxury Tech layout: ${lux.tablePath}`);
      }
      let final: string | null = null;
      if (args.bool("render")) {
        const { renderClip } = await import("../render/pipeline.ts");
        const { runQA } = await import("../qa/checks.ts");
        const { writeReport } = await import("../report.ts");
        const out = await renderClip(p, res.plan.clipId, {});
        const qa = await runQA({ p, plan: out.plan, record: out.record, captions: out.captions, sources: out.sources, dir: out.dir, luxury: out.luxury });
        const rec = { ...out.record, qaVerdict: qa.summary.verdict, paths: { ...out.record.paths, qa: join(out.dir, "qa.json") } as Record<string, string> };
        rec.paths.report = writeReport({ plan: out.plan, record: rec, qa, sources: out.sources, transcript: null, coverage: null, captions: out.captions, dir: out.dir });
        const { saveRender } = await import("../plans.ts");
        saveRender(p, rec);
        mkdirSync(P.edit(p), { recursive: true });
        final = join(P.edit(p), "final.mp4");
        copyFileSync(rec.paths.video!, final);
        info(`  ✓ stable delivery path: ${final} (versioned render kept at ${rec.paths.video})`);
      }
      return {
        json: { clipId: res.plan.clipId, version: res.plan.version, report: res.report, sync: res.sync, takes: res.plan.takes, final },
        human: [`creator plan ${res.plan.clipId} v${res.plan.version}: ${(res.plan.output.durationFlicks / 705_600_000).toFixed(2)} s`, `  report: ${res.report}`, ...(final ? [`  final: ${final}`] : [`  render: shorts-studio render ${p.config.id} --clip ${res.plan.clipId}`])].join("\n"),
      };
    },
  },
};
