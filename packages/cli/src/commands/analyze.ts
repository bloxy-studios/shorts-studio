import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AudioFeaturesSchema,
  CoverageSchema,
  VisualAnalysisSchema,
  readJsonIfExists,
  secondsToFlicks,
  writeJson,
  type AgentObservation,
  type AudioFeatures,
  type Coverage,
  type FaceTrack,
  type Scene,
  type SourceAsset,
  type SpeakerLink,
  type VisualAnalysis,
} from "../../../core/src/index.ts";
import { paths } from "../../../adapters/src/env.ts";
import { detectBlack, detectSceneCuts } from "../../../adapters/src/media/ffmpeg.ts";
import { py } from "../../../adapters/src/python.ts";
import { P, nowIso, type Project } from "../project.ts";
import { runStage } from "../jobs.ts";
import { info, stage, warn } from "../ui.ts";
import { loadSource } from "./ingest.ts";
import { loadTranscript } from "./transcribe.ts";

const S_PER_FLICK = 1 / 705_600_000;

export const A = {
  audio: (p: Project, id: string) => join(P.analysis(p, id), "audio.json"),
  envelope: (p: Project, id: string) => join(P.analysis(p, id), "envelope.json"),
  visual: (p: Project, id: string) => join(P.analysis(p, id), "visual.json"),
  coverage: (p: Project, id: string) => join(P.analysis(p, id), "coverage.json"),
  sheets: (p: Project, id: string) => join(P.analysis(p, id), "sheets"),
};

export function loadVisual(p: Project, id: string): VisualAnalysis | null {
  return readJsonIfExists(A.visual(p, id), VisualAnalysisSchema);
}

export function loadAudioFeatures(p: Project, id: string): AudioFeatures | null {
  return readJsonIfExists(A.audio(p, id), AudioFeaturesSchema);
}

export function loadCoverage(p: Project, id: string): Coverage | null {
  return readJsonIfExists(A.coverage(p, id), CoverageSchema);
}

interface PyFaces {
  detector: { name: string; model: string; version: string };
  sampling: { baseFps: number; framesAnalyzed: number; analysisWidth: number };
  frame: { width: number; height: number };
  tracks: Array<Omit<FaceTrack, "sceneId"> & { sceneIndex: number; centerJitterPx: number }>;
}

/** Links voices to faces only where the evidence supports it; otherwise records "none". */
export function linkSpeakers(scenes: Scene[], tracks: FaceTrack[], speech: Array<{ start: number; end: number }>): SpeakerLink[] {
  const links: SpeakerLink[] = [];
  for (const scene of scenes) {
    const inScene = tracks.filter((t) => t.sceneId === scene.id && t.visibility >= 0.5);
    const sceneSpeech = speech.filter((s) => s.end > scene.start && s.start < scene.end).reduce((a, s) => a + Math.min(s.end, scene.end) - Math.max(s.start, scene.start), 0);
    if (sceneSpeech === 0) continue;
    if (inScene.length === 1) {
      links.push({
        speakerId: `voice@${scene.id}`,
        trackId: inScene[0]!.id,
        confidence: 0.7,
        method: "single-face",
        evidence: `only one well-visible face (${inScene[0]!.id}, visibility ${inScene[0]!.visibility}) during ${(sceneSpeech * S_PER_FLICK).toFixed(1)} s of speech in ${scene.id}; off-camera voices remain possible`,
      });
    } else if (inScene.length > 1) {
      // Mouth-activity correlation with speech activity per track.
      const scores = inScene.map((t) => {
        const xs = t.samples.filter((s) => typeof s.mouthActivity === "number");
        if (xs.length < 8) return { t, r: 0 };
        const act = xs.map((s) => s.mouthActivity!);
        const sp = xs.map((s) => (speech.some((r) => s.t >= r.start && s.t < r.end) ? 1 : 0));
        const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
        const ma = mean(act);
        const ms = mean(sp);
        let num = 0;
        let da = 0;
        let ds = 0;
        for (let i = 0; i < act.length; i++) {
          num += (act[i]! - ma) * (sp[i]! - ms);
          da += (act[i]! - ma) ** 2;
          ds += (sp[i]! - ms) ** 2;
        }
        return { t, r: da > 0 && ds > 0 ? num / Math.sqrt(da * ds) : 0 };
      });
      scores.sort((a, b) => b.r - a.r);
      const best = scores[0]!;
      const second = scores[1]!;
      const margin = best.r - second.r;
      if (best.r > 0.25 && margin > 0.15) {
        links.push({
          speakerId: `voice@${scene.id}`,
          trackId: best.t.id,
          confidence: Math.min(0.8, 0.4 + margin),
          method: "av-correlation",
          evidence: `mouth activity of ${best.t.id} correlates r=${best.r.toFixed(2)} with speech vs r=${second.r.toFixed(2)} for ${second.t.id}`,
        });
      } else {
        links.push({
          speakerId: `voice@${scene.id}`,
          trackId: null,
          confidence: 0.3,
          method: "none",
          evidence: `${inScene.length} faces visible; mouth-activity evidence inconclusive (best r=${best.r.toFixed(2)}, margin ${margin.toFixed(2)}) — use a two-person or wide layout`,
        });
      }
    }
  }
  return links;
}

/** Audio features (envelope, VAD speech regions, events) — shared by analyze and transcribe. */
export async function ensureAudioFeatures(p: Project, src: SourceAsset, force = false): Promise<AudioFeatures | null> {
  if (!src.derived.audio16k) return null;
  const r = await runStage(p, `analyze.audio.${src.id}`, { hash: src.contentHash, v: "1" }, async () => {
    stage("audio", "10 ms RMS envelope, speech regions, pauses, loudness, events");
    const res = await py<Omit<AudioFeatures, "schemaVersion" | "sourceId" | "createdAt">>("audio.features", { wav: src.derived.audio16k!.path, windowMs: 10, envelopeOut: A.envelope(p, src.id) });
    const value = AudioFeaturesSchema.parse({ schemaVersion: 1, sourceId: src.id, createdAt: nowIso(), ...res });
    writeJson(A.audio(p, src.id), value);
    return { outputs: [A.audio(p, src.id), A.envelope(p, src.id)], value };
  }, { force });
  return r.value ?? loadAudioFeatures(p, src.id);
}

export interface AnalyzeOptions {
  sourceId: string;
  faceFps?: number;
  overviewTiles?: number;
  force?: boolean;
}

export async function analyze(p: Project, opts: AnalyzeOptions): Promise<{ visual: VisualAnalysis | null; audio: AudioFeatures | null; coverage: Coverage }> {
  const src = loadSource(p, opts.sourceId);
  const durS = src.probe.durationFlicks * S_PER_FLICK;
  const dir = P.analysis(p, src.id);

  const audio = await ensureAudioFeatures(p, src, Boolean(opts.force));
  if (audio) info(`  ✓ audio: ${audio.speech.length} speech regions, ${audio.pauses.length} pauses, ${audio.events.length} events, integrated ${audio.loudness.integratedLufs?.toFixed(1) ?? "n/a"} LUFS`);

  // Scenes + faces + overview sheets.
  let visual: VisualAnalysis | null = null;
  const v = src.probe.video;
  if (v && src.derived.analysisProxy) {
    const proxy = src.derived.analysisProxy;
    const faceFps = opts.faceFps ?? (durS > 1800 ? 2 : durS > 600 ? 3 : 5);
    const model = join(paths().modelsDir, "cv", "face_detection_yunet_2023mar.onnx");
    const r = await runStage(p, `analyze.visual.${src.id}`, { hash: src.contentHash, faceFps: String(faceFps), v: "2" }, async () => {
      stage("scenes", "frame-accurate scene cuts (ffmpeg scdet on the proxy)");
      const sceneCuts = (await detectSceneCuts(proxy.path, 10)).filter((c) => c.t > 0.2 && c.t < durS - 0.2);
      // Fades/gaps to black separate shots too (scdet misses gradual fades).
      const black = await detectBlack(proxy.path, 0.2);
      const blackCuts = black.flatMap((b) => [b.start, b.end]).filter((t) => t > 0.2 && t < durS - 0.2).map((t) => ({ t, score: 100 }));
      const cuts = [...sceneCuts, ...blackCuts].sort((a, b) => a.t - b.t).filter((c, i, arr) => i === 0 || c.t - arr[i - 1]!.t > 0.1);
      if (black.length) info(`  ✓ ${black.length} black stretch(es) recorded (never used as camera footage)`);
      const bounds = [0, ...cuts.map((c) => c.t), durS];
      const scenes: Scene[] = [];
      for (let i = 0; i < bounds.length - 1; i++) {
        if (bounds[i + 1]! - bounds[i]! < 0.04) continue;
        scenes.push({ id: `sc${String(scenes.length + 1).padStart(3, "0")}`, start: secondsToFlicks(bounds[i]!), end: secondsToFlicks(bounds[i + 1]!), cutScore: i === 0 ? 0 : cuts[i - 1]!.score });
      }
      info(`  ✓ ${scenes.length} scene(s)`);
      let tracks: FaceTrack[] = [];
      let detector = { name: "none", model: "none", version: "0" };
      let framesAnalyzed = 0;
      if (existsSync(model)) {
        stage("faces", `YuNet detection + IoU tracking at ${faceFps} fps (${Math.round(durS * faceFps)} frames)`);
        const res = await py<PyFaces>("cv.faces", { video: proxy.path, model, width: v.displayWidth, height: v.displayHeight, fps: faceFps, analysisWidth: proxy.width, sceneCutsS: cuts.map((c) => c.t) });
        detector = res.detector;
        framesAnalyzed = res.sampling.framesAnalyzed;
        tracks = res.tracks.map((t) => {
          const scene = scenes.find((s) => t.start >= s.start && t.start < s.end) ?? scenes[0]!;
          const { sceneIndex: _si, centerJitterPx: _cj, ...rest } = t;
          return { ...rest, sceneId: scene.id };
        });
        info(`  ✓ ${tracks.length} face track(s) over ${framesAnalyzed} sampled frames`);
      } else {
        warn("face model missing — run `shorts-studio doctor --setup`; framing will use safe static layouts");
      }
      const speech = audio?.speech ?? [];
      const speakerLinks = linkSpeakers(scenes, tracks, speech);
      // Overview sheets: scene-aware coverage, 12 tiles per sheet.
      const tiles = opts.overviewTiles ?? Math.min(48, Math.max(12, Math.ceil(durS / 12)));
      const sheetsDir = A.sheets(p, src.id);
      const times = overviewTimes(durS, tiles, scenes.map((s) => s.start * S_PER_FLICK));
      const frameSheets = [];
      for (let i = 0; i < times.length; i += 12) {
        const chunk = times.slice(i, i + 12);
        const id = `ov${String(i / 12 + 1).padStart(2, "0")}`;
        const out = join(sheetsDir, `${id}.jpg`);
        stage("sheet", `${id} (${chunk.length} frames)`);
        await py("cv.sheet", {
          video: src.localPath,
          times: chunk,
          out,
          width: v.displayWidth,
          height: v.displayHeight,
          tileW: 400,
          cols: 4,
          title: `${src.id} overview ${id} — ${fmt(chunk[0]!)} to ${fmt(chunk[chunk.length - 1]!)}`,
          fontPath: join(paths().fontsDir, "Inter-Variable.ttf"),
        });
        frameSheets.push({ id, path: out, times: chunk.map(secondsToFlicks), cols: 4, rows: Math.ceil(chunk.length / 4), purpose: "overview" as const });
      }
      const value: VisualAnalysis = VisualAnalysisSchema.parse({
        schemaVersion: 1,
        sourceId: src.id,
        detector,
        sampling: {
          baseFps: faceFps,
          denseWindows: [],
          framesAnalyzed,
          note: `faces sampled at ${faceFps} fps by timestamp; overview sheets show ${times.length} frames. This is sampled analysis, not frame-by-frame viewing.`,
        },
        frame: { width: v.displayWidth, height: v.displayHeight },
        scenes,
        faceTracks: tracks,
        speakerLinks,
        frameSheets,
        observations: loadVisual(p, src.id)?.observations ?? [],
        blackIntervals: black.map((b) => ({ start: secondsToFlicks(b.start), end: secondsToFlicks(b.end) })),
        createdAt: nowIso(),
      });
      writeJson(A.visual(p, src.id), value);
      return { outputs: [A.visual(p, src.id)], value };
    }, { force: Boolean(opts.force) });
    visual = r.value ?? loadVisual(p, src.id);
  }

  const transcript = loadTranscript(p, src.id);
  const prev = loadCoverage(p, src.id);
  const coverage: Coverage = CoverageSchema.parse({
    transcript: transcript ? "full" : "none",
    visual: visual ? (visual.observations.length > 0 ? "agent-inspected" : "cv-only") : "none",
    audio: audio ? "full" : "none",
    framesSampled: visual?.sampling.framesAnalyzed ?? 0,
    sheetsInspectedByAgent: prev?.sheetsInspectedByAgent ?? [],
    limitations: [
      ...(transcript ? [] : ["no transcript yet — run transcribe"]),
      ...(visual ? [`visual evidence is sampled (${visual.sampling.baseFps} fps faces, ${visual.frameSheets.reduce((a, s) => a + s.times.length, 0)} sheet frames)`] : ["no video stream: framing and visual evidence unavailable"]),
      ...(visual && visual.observations.length === 0 ? ["no agent inspection recorded yet: reactions/visual jokes are unverified (cv-only)"] : []),
    ],
  });
  writeJson(A.coverage(p, src.id), coverage);
  void dir;
  return { visual, audio, coverage };
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  return `${String(m).padStart(2, "0")}:${(t - m * 60).toFixed(1).padStart(4, "0")}`;
}

export function overviewTimes(durS: number, count: number, sceneStarts: number[]): number[] {
  const base: number[] = [];
  for (let i = 1; i <= count; i++) base.push((durS * i) / (count + 1));
  const extra = sceneStarts.filter((s) => s > 0.5 && s < durS - 0.5).map((s) => s + 0.5);
  const merged = [...new Set([...base, ...extra].map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
  if (merged.length <= count) return merged;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(merged[Math.round((i * (merged.length - 1)) / (count - 1))]!);
  return out;
}

/** Records an observation Claude made while inspecting a sheet (real visual evidence). */
export function addObservation(p: Project, sourceId: string, obs: Omit<AgentObservation, "at">): VisualAnalysis {
  const visual = loadVisual(p, sourceId);
  if (!visual) throw new Error(`run analyze for ${sourceId} first`);
  const next: VisualAnalysis = { ...visual, observations: [...visual.observations, { ...obs, at: nowIso() }] };
  writeJson(A.visual(p, sourceId), next);
  const cov = loadCoverage(p, sourceId);
  if (cov) {
    const inspected = obs.sheetId && !cov.sheetsInspectedByAgent.includes(obs.sheetId) ? [...cov.sheetsInspectedByAgent, obs.sheetId] : cov.sheetsInspectedByAgent;
    writeJson(A.coverage(p, sourceId), { ...cov, visual: "agent-inspected", sheetsInspectedByAgent: inspected, limitations: cov.limitations.filter((l) => !l.startsWith("no agent inspection")) });
  }
  return next;
}
