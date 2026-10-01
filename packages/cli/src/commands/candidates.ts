import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CandidateSetSchema,
  flicksToSeconds,
  formatTimecode,
  msToFlicks,
  parseTimecode,
  readJsonIfExists,
  writeJson,
  type Candidate,
  type CandidateSet,
  type Flicks,
  type Word,
} from "../../../core/src/index.ts";
import { splitSentences } from "../../../core/src/moments/sentences.ts";
import { generateWindows, type WindowContext } from "../../../core/src/moments/features.ts";
import { scoreWindow, selectMoments, toCandidate, type RankOptions } from "../../../core/src/moments/rank.ts";
import { loadPreset } from "../../../adapters/src/presets.ts";
import { paths } from "../../../adapters/src/env.ts";
import { py } from "../../../adapters/src/python.ts";
import { run } from "../../../adapters/src/proc.ts";
import { tool } from "../../../adapters/src/tools.ts";
import type { Args } from "../args.ts";
import type { Command } from "../registry.ts";
import { P, nowIso, type Project } from "../project.ts";
import { info, stage, table } from "../ui.ts";
import { defaultSource, loadSource } from "./ingest.ts";
import { loadTranscript } from "./transcribe.ts";
import { loadAudioFeatures, loadCoverage, loadVisual } from "./analyze.ts";

export function candidatesPath(p: Project): string {
  return P.candidates(p);
}

export function loadCandidates(p: Project): CandidateSet | null {
  return readJsonIfExists(candidatesPath(p), CandidateSetSchema);
}

function saveCandidates(p: Project, set: CandidateSet): void {
  writeJson(candidatesPath(p), CandidateSetSchema.parse(set));
}

/** Scene cuts with real silence on both sides separate unrelated answers in compilations. */
function hardBoundaries(words: readonly Word[], sceneStarts: Flicks[]): Flicks[] {
  const out: Flicks[] = [];
  for (const t of sceneStarts) {
    const before = [...words].reverse().find((w) => w.end <= t + msToFlicks(200));
    const after = words.find((w) => w.start >= t - msToFlicks(200));
    const spanning = words.some((w) => w.start < t - msToFlicks(200) && w.end > t + msToFlicks(200));
    if (spanning) continue;
    const silence = (after ? after.start : Number.MAX_SAFE_INTEGER) - (before ? before.end : 0);
    if (silence >= msToFlicks(900)) out.push(t);
  }
  return out;
}

export interface BuildOptions {
  sourceId?: string;
  count?: number;
  band?: { minSec: number; maxSec: number };
}

export function buildCandidates(p: Project, opts: BuildOptions = {}): CandidateSet {
  const src = opts.sourceId ? loadSource(p, opts.sourceId) : defaultSource(p);
  const transcript = loadTranscript(p, src.id);
  if (!transcript || transcript.words.length === 0) throw new Error(`no transcript words for ${src.id}; run transcribe first`);
  const audio = loadAudioFeatures(p, src.id);
  const visual = loadVisual(p, src.id);
  const coverage = loadCoverage(p, src.id);
  const preset = loadPreset(p.config.presetId);
  const band = opts.band ?? p.config.durationBand ?? preset.selection.durationBand;
  const count = opts.count ?? p.config.clipCount ?? 3;
  const sentences = splitSentences(transcript.words);
  const ctx: WindowContext = {
    sentences,
    events: audio?.events ?? [],
    observations: visual?.observations ?? [],
    faceTracks: visual?.faceTracks ?? [],
    scenes: visual?.scenes ?? [],
    hardBoundaries: hardBoundaries(transcript.words, (visual?.scenes ?? []).slice(1).map((s) => s.start)),
    faceFps: visual?.sampling.baseFps ?? 5,
  };
  const visualCoverage: RankOptions["visualCoverage"] = !visual ? "none" : coverage?.visual === "agent-inspected" || (visual.observations.length ?? 0) > 0 ? "agent-inspected" : "cv-only";
  const intensity = (p.config.intensity ?? (preset.framing.cameraFootageMotion === "restrained" ? "restrained" : preset.framing.cameraFootageMotion === "energetic" ? "energetic" : "balanced")) as RankOptions["intensity"];
  const opts2: RankOptions = {
    sourceId: src.id,
    weights: preset.scoring.weights,
    penalties: preset.scoring.penalties,
    band,
    maxIou: preset.selection.maxIou,
    minGapSec: preset.selection.minGapSec,
    count,
    qualityBar: 50,
    captionStyleId: p.config.captionStyleId ?? preset.captions.defaultStyleId,
    intensity,
    speakerLinks: visual?.speakerLinks ?? [],
    visualCoverage,
  };
  const windows = generateWindows(ctx, band);
  stage("candidates", `${sentences.length} sentences → ${windows.length} sentence-bounded windows in ${band.minSec}–${band.maxSec} s`);
  const scored = windows.map((w) => scoreWindow(w, ctx, opts2));
  const sel = selectMoments(scored, opts2);
  const candidates: Candidate[] = [
    ...sel.chosen.map((s, i) => toCandidate(s, ctx, opts2, `c-${String(i + 1).padStart(3, "0")}`, true)),
    ...sel.nearMisses.map((s, i) => toCandidate(s, ctx, opts2, `x-${String(i + 1).padStart(3, "0")}`, false)),
  ];
  return CandidateSetSchema.parse({
    schemaVersion: 1,
    sourceId: src.id,
    createdAt: nowIso(),
    requested: { count, minSec: band.minSec, maxSec: band.maxSec },
    weights: preset.scoring.weights,
    candidates,
    shortfall: sel.shortfall,
    method: `sentence-bounded windows scored with the ${preset.id} editorial rubric (hook/payoff/standalone/emotion/delivery/fit − explicit penalties); greedy diverse selection (IoU ≤ ${preset.selection.maxIou}, gap ≥ ${preset.selection.minGapSec} s). Editorial potential, not a virality prediction. Visual evidence: ${visualCoverage}.`,
  });
}

function rows(set: CandidateSet): Array<Record<string, string | number>> {
  return set.candidates.map((c, i) => ({
    rank: c.selection.state === "rejected" ? "-" : i + 1,
    id: c.id,
    range: `${formatTimecode(c.start)}–${formatTimecode(c.end)}`,
    sec: flicksToSeconds(c.end - c.start).toFixed(1),
    score: c.scores.total,
    kind: c.kind,
    level: c.analysisLevel.replace("audiovisual-", "av-"),
    state: c.selection.state,
    title: c.title.slice(0, 48),
  }));
}

async function preview(p: Project, top: number): Promise<CandidateSet> {
  const set = loadCandidates(p);
  if (!set) throw new Error("no candidates yet; run `candidates <project>` first");
  const src = loadSource(p, set.sourceId);
  const proxy = src.derived.analysisProxy;
  const dir = join(p.dir, "analysis", "previews");
  mkdirSync(dir, { recursive: true });
  const out: Candidate[] = [];
  let made = 0;
  for (const c of set.candidates) {
    if (made >= top || c.selection.state === "rejected" || !proxy) {
      out.push(c);
      continue;
    }
    const s = flicksToSeconds(c.start);
    const d = flicksToSeconds(c.end - c.start);
    const mp4 = join(dir, `${c.id}.mp4`);
    stage("preview", `${c.id} ${formatTimecode(c.start)}–${formatTimecode(c.end)}`);
    const audioArgs = src.derived.audio48k ? ["-ss", s.toFixed(3), "-t", d.toFixed(3), "-i", src.derived.audio48k.path] : [];
    await run([
      tool("ffmpeg"), "-hide_banner", "-nostdin", "-y", "-v", "error",
      "-ss", s.toFixed(3), "-t", d.toFixed(3), "-i", proxy.path, ...audioArgs,
      "-map", "0:v:0", ...(audioArgs.length ? ["-map", "1:a:0", "-c:a", "aac", "-b:a", "64k"] : []),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-movflags", "+faststart", mp4,
    ], { timeoutMs: 600_000 });
    const sheet = join(dir, `${c.id}.jpg`);
    const times = Array.from({ length: 6 }, (_, k) => s + (d * (k + 0.5)) / 6);
    await py("cv.sheet", {
      video: proxy.path, times, out: sheet, width: proxy.width, height: proxy.height, tileW: 320, cols: 3,
      title: `${c.id} · ${c.title} · ${formatTimecode(c.start)}–${formatTimecode(c.end)}`,
      fontPath: join(paths().fontsDir, "Inter-Variable.ttf"),
    });
    out.push({ ...c, preview: { path: mp4, contactSheet: sheet } });
    made++;
  }
  const next = { ...set, candidates: out };
  saveCandidates(p, next);
  return next;
}

function note(p: Project, args: Args): Candidate {
  const set = loadCandidates(p);
  if (!set) throw new Error("no candidates yet");
  const id = args.req("id");
  const idx = set.candidates.findIndex((c) => c.id === id);
  if (idx < 0) throw new Error(`unknown candidate ${id}`);
  let c = { ...set.candidates[idx]! };
  if (args.str("title")) c.title = args.req("title");
  if (args.str("hook")) c.hook = args.req("hook");
  if (args.str("why")) c.whyItHolds = args.req("why");
  if (args.str("start") || args.str("end")) {
    const transcript = loadTranscript(p, c.sourceId);
    const words = transcript?.words ?? [];
    let start = args.str("start") ? parseTimecode(args.req("start")) : c.start;
    let end = args.str("end") ? parseTimecode(args.req("end")) : c.end;
    // Snap to whole words: never start or end inside a word.
    const inside = words.filter((w) => w.end > start && w.start < end);
    if (inside.length) {
      start = Math.min(start, inside[0]!.start);
      end = Math.max(end, inside[inside.length - 1]!.end);
    }
    c = { ...c, start, end, tentativeDurationFlicks: end - start };
  }
  if (args.str("state")) {
    const state = args.req("state") as Candidate["selection"]["state"];
    if (!["selected", "rejected", "shortlisted", "proposed"].includes(state)) throw new Error("--state must be selected|rejected|shortlisted|proposed");
    c.selection = { state, ...(args.str("reason") ? { reason: args.req("reason") } : {}), at: nowIso() };
  }
  if (args.str("evidence")) {
    c.evidence = [...c.evidence, { kind: (args.str("evidence-kind") as Candidate["evidence"][number]["kind"]) ?? "visual-agent", ...(args.str("at") ? { t: parseTimecode(args.req("at")) } : {}), detail: args.req("evidence") }];
    if (c.evidence.some((e) => e.kind === "visual-agent")) {
      c.analysisLevel = "audiovisual-agent";
      c.confidence = { ...c.confidence, visual: Math.max(c.confidence.visual, 0.8) };
    }
  }
  if (args.num("editorial") !== undefined) c.confidence = { ...c.confidence, editorial: Math.max(0, Math.min(1, args.num("editorial")!)) };
  const candidates = set.candidates.map((x, i) => (i === idx ? c : x));
  saveCandidates(p, { ...set, candidates });
  return c;
}

export const candidateCommands: Record<string, Command> = {
  candidates: {
    summary: "Rank standalone moments with evidence (build | preview | note | show)",
    usage: `shorts-studio candidates <project> [--source ID] [--count N] [--duration MIN-MAX]
shorts-studio candidates preview <project> [--top N]
shorts-studio candidates note <project> --id ID [--title T] [--hook H] [--why W] [--start TIME --end TIME] [--state selected|rejected|shortlisted --reason R] [--evidence TEXT --at TIME] [--editorial 0-1]
shorts-studio candidates show <project> --id ID`,
    async run(args) {
      const { loadProject } = await import("../project.ts");
      const sub = args.positionals[0];
      if (sub === "preview") {
        const p = loadProject(args.pos(1, "project"));
        const set = await preview(p, args.num("top", 3)!);
        const made = set.candidates.filter((c) => c.preview);
        return { json: { previews: made.map((c) => ({ id: c.id, ...c.preview })) }, human: made.map((c) => `${c.id}: ${c.preview!.path}\n      sheet: ${c.preview!.contactSheet}`).join("\n") };
      }
      if (sub === "note") {
        const p = loadProject(args.pos(1, "project"));
        const c = note(p, args);
        return { json: c, human: `${c.id} updated (${c.selection.state}): ${c.title}` };
      }
      if (sub === "show") {
        const p = loadProject(args.pos(1, "project"));
        const c = loadCandidates(p)?.candidates.find((x) => x.id === args.req("id"));
        if (!c) throw new Error(`unknown candidate ${args.str("id")}`);
        return { json: c, human: JSON.stringify(c, null, 2) };
      }
      const p = loadProject(args.pos(0, "project"));
      const bandText = args.str("duration");
      const m = bandText ? /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(bandText) : null;
      if (bandText && !m) throw new Error("--duration expects MIN-MAX seconds, e.g. 20-60");
      if (existsSync(candidatesPath(p))) copyFileSync(candidatesPath(p), candidatesPath(p).replace(/\.json$/, ".prev.json"));
      const set = buildCandidates(p, {
        ...(args.str("source") ? { sourceId: args.str("source")! } : {}),
        ...(args.num("count") ? { count: args.num("count")! } : {}),
        ...(m ? { band: { minSec: Number(m[1]), maxSec: Number(m[2]) } } : {}),
      });
      saveCandidates(p, set);
      info(`  ${set.method}`);
      const lines = [table(rows(set)), ...(set.shortfall ? [`\nshortfall: ${set.shortfall}`] : []), `\nsaved ${candidatesPath(p)}`];
      return { json: set, human: lines.join("\n") };
    },
  },
};
