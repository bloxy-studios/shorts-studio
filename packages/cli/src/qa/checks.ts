import { join } from "node:path";
import {
  QAReportSchema,
  flicksPerFrame,
  flicksPerSample,
  flicksToSeconds,
  formatRational,
  formatTimecode,
  secondsToFlicks,
  writeJson,
  type EditPlan,
  type InspectionRecord,
  type QAFinding,
  type QAReport,
  type RenderRecord,
  type SourceAsset,
} from "../../../core/src/index.ts";
import { paths } from "../../../adapters/src/env.ts";
import { loadPlatforms } from "../../../adapters/src/presets.ts";
import { measureEbur128 } from "../../../adapters/src/media/ffmpeg.ts";
import { py } from "../../../adapters/src/python.ts";
import { run } from "../../../adapters/src/proc.ts";
import { tool } from "../../../adapters/src/tools.ts";
import type { CaptionBand } from "../render/pipeline.ts";
import { pieces } from "../render/video.ts";
import { loadVisual } from "../commands/analyze.ts";
import type { Project } from "../project.ts";
import { stage } from "../ui.ts";
import type { LuxuryLayers } from "../luxury/render.ts";
import { luxuryChecks } from "./luxury.ts";

interface ProbeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  nb_read_packets?: string;
  sample_rate?: string;
  channels?: number;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
}

let seq = 0;
type FindingInput = Omit<QAFinding, "id" | "evidence" | "affects"> & {
  evidence?: Partial<QAFinding["evidence"]>;
  affects?: Partial<QAFinding["affects"]>;
};

function finding(f: FindingInput): QAFinding {
  seq += 1;
  return {
    id: `qa${String(seq).padStart(3, "0")}`,
    evidence: { frames: [], times: [], measurements: {}, ...(f.evidence ?? {}) },
    affects: { segmentIds: [], runIds: [], chunkIds: [], eventIds: [], ...(f.affects ?? {}) },
    ...f,
  } as QAFinding;
}

export interface QAInput {
  p: Project;
  plan: EditPlan;
  record: RenderRecord;
  captions: CaptionBand | null;
  sources: Map<string, SourceAsset>;
  dir: string;
  platform?: string;
  /** Rendered Luxury Tech layers (matte QA etc.), when the plan uses them. */
  luxury?: LuxuryLayers | null;
}

export async function runQA(input: QAInput): Promise<QAReport> {
  seq = 0;
  const { plan, record, captions, dir } = input;
  const findings: QAFinding[] = [];
  const inspection: InspectionRecord[] = [];
  const video = record.paths.video!;
  const fps = plan.output.fps;
  const frame = flicksPerFrame(fps);
  const fpsNum = fps.num / fps.den;

  // E1: delivered spec.
  stage("qa", "probing delivered file");
  const probe = JSON.parse(
    (await run([tool("ffprobe"), "-v", "error", "-count_packets", "-show_streams", "-show_format", "-of", "json", video], { timeoutMs: 600_000 })).stdout,
  ) as { streams: ProbeStream[]; format: { duration: string } };
  const v = probe.streams.find((s) => s.codec_type === "video");
  const a = probe.streams.find((s) => s.codec_type === "audio");
  const specProblems: string[] = [];
  if (!v) specProblems.push("no video stream");
  else {
    if (v.codec_name !== "h264") specProblems.push(`video codec ${v.codec_name}`);
    if (v.width !== plan.output.width || v.height !== plan.output.height) specProblems.push(`size ${v.width}x${v.height}`);
    if (v.pix_fmt !== "yuv420p") specProblems.push(`pix_fmt ${v.pix_fmt}`);
    if (v.r_frame_rate !== formatRational(fps) && v.r_frame_rate !== `${fps.num}/${fps.den}`) specProblems.push(`fps ${v.r_frame_rate}`);
    if (Number(v.nb_read_packets) !== plan.output.frameCount) specProblems.push(`${v.nb_read_packets} frames (expected ${plan.output.frameCount})`);
  }
  if (!a) specProblems.push("no audio stream");
  else {
    if (a.codec_name !== "aac") specProblems.push(`audio codec ${a.codec_name}`);
    if (Number(a.sample_rate) !== plan.output.sampleRate) specProblems.push(`sample rate ${a.sample_rate}`);
    if (a.channels !== plan.output.audioChannels) specProblems.push(`${a.channels} channels`);
  }
  findings.push(
    finding({
      check: "export.spec",
      category: "export",
      severity: "hard",
      status: specProblems.length ? "fail" : "pass",
      message: specProblems.length ? `delivered file deviates from the profile: ${specProblems.join("; ")}` : `H.264 ${plan.output.width}x${plan.output.height} yuv420p @ ${formatRational(fps)} fps, ${plan.output.frameCount} frames, AAC ${plan.output.sampleRate} Hz ${plan.output.audioChannels} ch`,
      evidence: { measurements: { videoStream: v ?? null, audioStream: a ?? null, formatDuration: probe.format.duration, color: v ? `${v.color_primaries}/${v.color_transfer}/${v.color_space}` : null } },
    }),
  );

  // E2: full decode.
  stage("qa", "full decode check");
  const dec = await run([tool("ffmpeg"), "-v", "error", "-nostdin", "-i", video, "-f", "null", "-"], { allowFailure: true, timeoutMs: 1800_000 });
  findings.push(
    finding({
      check: "export.decode",
      category: "export",
      severity: "hard",
      status: dec.code === 0 && dec.stderr.trim() === "" ? "pass" : "fail",
      message: dec.code === 0 && dec.stderr.trim() === "" ? "entire file decodes without errors" : `decode errors: ${dec.stderr.trim().slice(0, 400)}`,
    }),
  );

  // A1: loudness/true peak of what the viewer hears (decoded AAC).
  stage("qa", "loudness and true peak (EBU R128, oversampled)");
  const loud = await measureEbur128(video);
  const target = plan.audio.master.targetLufs;
  const lufsOk = loud.integratedLufs !== null && Math.abs(loud.integratedLufs - target) <= 1.0;
  const tpOk = loud.truePeakDbtp !== null && loud.truePeakDbtp <= plan.audio.master.maxTruePeakDbtp + 0.05;
  findings.push(
    finding({
      check: "audio.loudness",
      category: "audio",
      severity: "soft",
      status: lufsOk ? "pass" : "warn",
      message: `delivered integrated loudness ${loud.integratedLufs?.toFixed(2) ?? "n/a"} LUFS (target ${target} ±1.0 after AAC; master WAV ${record.master?.integratedLufs?.toFixed(2) ?? "n/a"} LUFS)`,
      evidence: { measurements: { ...loud, masterWav: record.master } },
    }),
  );
  findings.push(
    finding({
      check: "audio.true-peak",
      category: "audio",
      severity: "hard",
      status: tpOk ? "pass" : "fail",
      message: `delivered true peak ${loud.truePeakDbtp?.toFixed(2) ?? "n/a"} dBTP (ceiling ${plan.audio.master.maxTruePeakDbtp} dBTP)`,
      evidence: { measurements: { truePeakDbtp: loud.truePeakDbtp } },
      ...(tpOk ? {} : { repair: { rule: "audio.master.maxTruePeakDbtp", action: "lower the master ceiling by 0.5 dB before AAC encoding" } }),
    }),
  );

  // A2: stems share END exactly.
  const endSamples = Math.round(plan.output.durationFlicks / flicksPerSample(plan.output.sampleRate));
  const stemLens = Object.entries(record.stems).map(([k, s]) => [k, s.durationSamples] as const);
  const badStems = stemLens.filter(([, n]) => n !== endSamples);
  findings.push(
    finding({
      check: "audio.stem-length",
      category: "audio",
      severity: "hard",
      status: badStems.length ? "fail" : "pass",
      message: badStems.length ? `stems not END-length: ${badStems.map(([k, n]) => `${k}=${n}`).join(", ")} (END ${endSamples})` : `${stemLens.length} stem(s) all exactly ${endSamples} samples (END)`,
      evidence: { measurements: Object.fromEntries(stemLens) },
    }),
  );

  // C1: caption onsets vs speech in the final mix.
  if (plan.captions && plan.captions.chunks.length > 0 && record.paths.master) {
    stage("qa", "caption timing against the final voice track");
    const feats = await py<{ speech: Array<{ start: number; end: number }> }>("audio.features", { wav: record.paths.master, windowMs: 10, envelopeOut: join(dir, "qa", "master_envelope.json") });
    const speech = feats.speech;
    const tol = secondsToFlicks(0.12);
    const offsets: number[] = [];
    const silentChunks: string[] = [];
    for (const c of plan.captions.chunks) {
      const overlap = speech.reduce((acc, r) => acc + Math.max(0, Math.min(r.end, c.outEnd) - Math.max(r.start, c.outStart)), 0);
      if (overlap / (c.outEnd - c.outStart) < 0.2) silentChunks.push(c.id);
      const first = c.words[0]!;
      const region = speech.find((r) => r.end >= first.outStart - tol && r.start <= first.outEnd + tol);
      if (region) offsets.push(Math.max(0, region.start - first.outStart));
    }
    const med = offsets.length ? offsets.sort((x, y) => x - y)[Math.floor(offsets.length / 2)]! : 0;
    findings.push(
      finding({
        check: "captions.sync",
        category: "captions",
        severity: "hard",
        status: silentChunks.length > Math.max(1, plan.captions.chunks.length * 0.1) ? "fail" : silentChunks.length ? "warn" : "pass",
        message: `${plan.captions.chunks.length - silentChunks.length}/${plan.captions.chunks.length} caption chunks overlap measured speech in the final mix; median onset lag ${(flicksToSeconds(med) * 1000).toFixed(0)} ms`,
        evidence: { measurements: { silentChunks, medianOnsetLagMs: flicksToSeconds(med) * 1000 } },
        affects: { segmentIds: [], runIds: [], chunkIds: silentChunks, eventIds: [] },
        ...(silentChunks.length ? { repair: { rule: "captions.timing", action: "rebuild captions from the time map; check for dropped words at cuts" } } : {}),
      }),
    );
  }

  // C2/C3: caption bounds vs safe area and faces.
  if (captions && plan.captions) {
    const guides = loadPlatforms().guides[input.platform ?? "generic-9x16"] ?? loadPlatforms().guides["generic-9x16"]!;
    const W = plan.output.width;
    const H = plan.output.height;
    const outside: string[] = [];
    const faceHits: Array<{ chunkId: string; overlap: number }> = [];
    const visual = [...input.sources.values()].map((s) => loadVisual(input.p, s.id)).find(Boolean) ?? null;
    for (const st of captions.states) {
      const b = captions.stateBounds[st.index];
      if (!b) continue;
      const x0 = b.x0;
      const x1 = b.x1;
      // State bounds are measured on the full-canvas state frames (canvas coordinates).
      const y0 = b.y0;
      const y1 = b.y1;
      if (x0 < guides.left || x1 > W - guides.right || y0 < guides.top || y1 > H - guides.bottom) outside.push(st.chunkId);
      // Face overlap: map the face box at the chunk's source time into canvas space.
      const chunk = plan.captions.chunks.find((c) => c.id === st.chunkId);
      if (!chunk || !visual) continue;
      const mid = Math.round((chunk.outStart + chunk.outEnd) / 2 / frame) * frame;
      const pc = pieces(plan).find((pp) => mid >= pp.outStart && mid < pp.outEnd);
      const crop = plan.cropPaths.find((c) => c.id === pc?.cropPathId);
      if (!pc || !crop) continue;
      const srcT = pc.srcStart + (mid - pc.outStart);
      const box = crop.keyframes[0]!.box;
      // Faces map through the slot that shows this crop (full canvas, a card window, …).
      const region = pc.slots.find((sl) => sl.cropPathId === crop.id)?.region ?? { x: 0, y: 0, w: W, h: H };
      const sx = region.w / box.w;
      const sy = region.h / box.h;
      for (const tr of visual.faceTracks) {
        const sample = tr.samples.reduce<(typeof tr.samples)[number] | null>((best, s) => (Math.abs(s.t - srcT) < Math.abs((best?.t ?? Infinity) - srcT) ? s : best), null);
        if (!sample || Math.abs(sample.t - srcT) > secondsToFlicks(0.5)) continue;
        const fx0 = region.x + (sample.box.x - box.x) * sx;
        const fy0 = region.y + (sample.box.y - box.y) * sy;
        const fx1 = fx0 + sample.box.w * sx;
        const fy1 = fy0 + sample.box.h * sy;
        const ix = Math.max(0, Math.min(fx1, x1) - Math.max(fx0, x0));
        const iy = Math.max(0, Math.min(fy1, y1) - Math.max(fy0, y0));
        const frac = (ix * iy) / Math.max(1, (fx1 - fx0) * (fy1 - fy0));
        if (frac > 0.05) faceHits.push({ chunkId: st.chunkId, overlap: Math.round(frac * 100) / 100 });
      }
    }
    const uniqOutside = [...new Set(outside)];
    findings.push(
      finding({
        check: "captions.safe-area",
        category: "captions",
        severity: "soft",
        status: uniqOutside.length ? "warn" : "pass",
        message: uniqOutside.length ? `${uniqOutside.length} caption chunk(s) extend into the ${input.platform ?? "generic-9x16"} UI guide margins (approximate guides)` : `all rendered caption bounds stay inside the ${input.platform ?? "generic-9x16"} guide margins (approximate guides)`,
        evidence: { measurements: { guides, chunks: uniqOutside } },
        affects: { segmentIds: [], runIds: [], chunkIds: uniqOutside, eventIds: [] },
      }),
    );
    const uniqFace = [...new Map(faceHits.map((f) => [f.chunkId, f])).values()];
    findings.push(
      finding({
        check: "captions.face-collision",
        category: "captions",
        severity: "soft",
        status: uniqFace.length ? "warn" : "pass",
        message: uniqFace.length ? `${uniqFace.length} caption chunk(s) overlap a detected face (sampled tracks)` : "no rendered caption overlaps a detected face (5 fps face samples)",
        evidence: { measurements: { hits: uniqFace } },
        affects: { segmentIds: [], runIds: [], chunkIds: uniqFace.map((f) => f.chunkId), eventIds: [] },
        ...(uniqFace.length ? { repair: { rule: "layout.captionZone", action: "move the caption zone for the affected run(s) away from the face" } } : {}),
      }),
    );
  }

  // V1/V2: black/frozen detection and cut sheets for inspection.
  stage("qa", "black/frozen frame detection");
  const bf = await run([tool("ffmpeg"), "-hide_banner", "-nostdin", "-i", video, "-vf", "blackdetect=d=0.4:pix_th=0.08,freezedetect=n=0.002:d=1.5", "-an", "-f", "null", "-"], { allowFailure: true, timeoutMs: 1800_000 });
  const blacks = [...bf.stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const freezes = [...bf.stderr.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  findings.push(
    finding({
      check: "video.black-frozen",
      category: "export",
      severity: "soft",
      status: blacks.length || freezes.length ? "warn" : "pass",
      message: blacks.length || freezes.length ? `${blacks.length} black stretch(es) ≥0.4 s, ${freezes.length} frozen stretch(es) ≥1.5 s — confirm they exist in the source` : "no black or frozen stretches detected",
      evidence: { measurements: { blacks, freezes }, times: [...blacks.map((b) => secondsToFlicks(b[0]!)), ...freezes.map(secondsToFlicks)] },
    }),
  );

  // Luxury Tech preset checks (layouts, static footage, landing frames, highlights, SFX, matte, ground, cover).
  if (plan.layoutRuns.some((r) => r.layout.startsWith("lt-"))) {
    stage("qa", "Luxury Tech checks (layouts, footage, landing frames, highlights, SFX, matte, ground, cover)");
    for (const f of await luxuryChecks({ plan, record, captions, video, luxury: input.luxury ?? null, sources: input.sources })) findings.push(finding(f));
  }

  // E3: no blank tail.
  const tail = plan.output.durationFlicks - plan.output.voiceEndFlicks;
  findings.push(
    finding({
      check: "timing.end",
      category: "timing",
      severity: "hard",
      status: tail < frame ? "pass" : "fail",
      message: `voice ends at ${(flicksToSeconds(plan.output.voiceEndFlicks) * 1000).toFixed(1)} ms; END ${(flicksToSeconds(plan.output.durationFlicks) * 1000).toFixed(1)} ms = frame ${plan.output.frameCount} (tail ${(flicksToSeconds(tail) * 1000).toFixed(1)} ms < 1 frame)`,
    }),
  );

  // Inspection sheets (cuts + overview) for agent/human review of real frames.
  stage("qa", "frame sheets around cuts and across the video");
  const cuts = [...new Set([...plan.segments.slice(1).map((s) => s.picture.outStart), ...plan.layoutRuns.slice(1).map((r) => r.outStart)])].sort((x, y) => x - y);
  const cutTimes: number[] = [];
  const cutLabels: string[] = [];
  for (const c of cuts.slice(0, 12)) {
    cutTimes.push(flicksToSeconds(c - frame), flicksToSeconds(c));
    cutLabels.push("before cut", "after cut");
  }
  const fontPath = join(paths().fontsDir, "Inter-Variable.ttf");
  const sheets: string[] = [];
  if (cutTimes.length) {
    const out = join(dir, "qa", "cuts.jpg");
    await py("cv.sheet", { video, times: cutTimes, out, width: plan.output.width, height: plan.output.height, tileW: 270, cols: 6, title: `${plan.clipId} ${record.id}: frames either side of ${cuts.length} cut(s)`, labels: cutLabels, fontPath });
    sheets.push(out);
  }
  const total = flicksToSeconds(plan.output.durationFlicks);
  const n = Math.min(18, Math.max(6, Math.ceil(total / 3)));
  const overview = Array.from({ length: n }, (_, i) => Math.min(total - 1 / fpsNum, (i * total) / (n - 1)));
  overview[0] = 0;
  const outOv = join(dir, "qa", "contact.jpg");
  await py("cv.sheet", { video, times: overview, out: outOv, width: plan.output.width, height: plan.output.height, tileW: 270, cols: 6, title: `${plan.clipId} ${record.id}: whole-video contact sheet (first and last frames included)`, fontPath });
  sheets.push(outOv);
  for (const s of sheets) inspection.push({ what: `visual review of ${s.split("/").pop()}`, how: "not-performed", artifact: s, notes: "Awaiting agent/human inspection; record with `shorts-studio qa note`." });
  inspection.push({ what: "automated technical, timing, loudness and caption-geometry checks", how: "automated", notes: `${findings.length} checks recorded` });
  inspection.push({ what: "full playback", how: "not-performed", notes: "This environment cannot watch video in real time; review preview_540x960.mp4 in a player." });

  const hard = findings.filter((f) => f.severity === "hard" && f.status === "fail").length;
  // Any warning (whatever its severity) or soft failure makes the verdict "pass-with-warnings".
  const soft = findings.filter((f) => (f.status === "warn" && f.severity !== "info") || (f.severity === "soft" && f.status === "fail")).length;
  const report: QAReport = QAReportSchema.parse({
    schemaVersion: 1,
    clipId: plan.clipId,
    renderId: record.id,
    planVersion: plan.version,
    createdAt: new Date().toISOString(),
    findings,
    inspection,
    summary: {
      hardFailures: hard,
      softFailures: findings.filter((f) => f.status === "fail" && f.severity === "soft").length,
      warnings: findings.filter((f) => f.status === "warn").length,
      passed: findings.filter((f) => f.status === "pass").length,
      notRun: findings.filter((f) => f.status === "not-run").length,
      verdict: hard > 0 ? (record.kind === "final" ? "blocked" : "draft") : soft > 0 ? "pass-with-warnings" : "pass",
    },
  });
  writeJson(join(dir, "qa.json"), report);
  void formatTimecode;
  return report;
}
