import type { Flicks } from "../time.ts";
import { formatTimecode, msToFlicks } from "../time.ts";
import { iou } from "../interval.ts";
import { normalizeToken } from "../captions/lexicon.ts";
import type { Candidate, Criteria, Penalty } from "../schema/candidate.ts";
import type { Evidence } from "../schema/common.ts";
import type { SpeakerLink } from "../schema/analysis.ts";
import { openingTrim, type Sentence } from "./sentences.ts";
import { windowFeatures, type MomentWindow, type WindowContext, type WindowFeatures } from "./features.ts";

export interface RankOptions {
  sourceId: string;
  weights: { hook: number; payoff: number; standalone: number; emotion: number; delivery: number; fit: number };
  penalties: Record<string, number>;
  band: { minSec: number; maxSec: number };
  maxIou: number;
  minGapSec: number;
  count: number;
  /** Minimum total score for a moment to count as strong (default 50). */
  qualityBar?: number;
  captionStyleId: string;
  intensity: "restrained" | "balanced" | "energetic";
  speakerLinks: SpeakerLink[];
  /** visual coverage of the source: decides analysisLevel/visual confidence. */
  visualCoverage: "agent-inspected" | "cv-only" | "none";
}

export interface Scored {
  window: MomentWindow;
  features: WindowFeatures;
  criteria: Criteria;
  penalties: Penalty[];
  total: number;
}

export function scoreWindow(window: MomentWindow, ctx: WindowContext, opts: RankOptions): Scored {
  const f = windowFeatures(window, ctx, opts.band);
  const criteria: Criteria = {
    hook: f.hook.score,
    payoff: f.payoff.score,
    standalone: f.standalone.score,
    emotion: f.emotion.score,
    delivery: f.delivery.score,
    fit: f.fit.score,
  };
  const w = opts.weights;
  const base = w.hook * criteria.hook + w.payoff * criteria.payoff + w.standalone * criteria.standalone + w.emotion * criteria.emotion + w.delivery * criteria.delivery + w.fit * criteria.fit;
  const penalties: Penalty[] = [];
  const pen = (kind: Penalty["kind"], reason: string) => penalties.push({ kind, points: opts.penalties[kind] ?? 10, reason });
  if (f.missingSetup) pen("missing-setup", "starts mid-thought (conjunction/reference directly after the previous sentence)");
  if (f.standalone.unresolved.length) pen("unresolved-reference", f.standalone.unresolved.join("; "));
  if (f.delivery.score < 0.35) pen("weak-delivery", f.delivery.reasons.join(", "));
  if (f.truncationRisk) pen("misleading-truncation", f.truncationRisk);
  if (f.audio.clipping.length) pen("poor-audio", `${f.audio.clipping.length} clipping event(s)`);
  if (opts.visualCoverage !== "none" && f.visual.faceFraction < 0.25 && !f.visual.observations.some((o) => o.kind === "screen-demo")) {
    pen("unusable-crop", `faces visible in only ${Math.round(f.visual.faceFraction * 100)}% of sampled frames and no screen demo noted`);
  }
  const total = Math.max(0, Math.round((base - penalties.reduce((a, p) => a + p.points, 0)) * 10) / 10);
  return { window, features: f, criteria, penalties, total };
}

const LEADING_FILLER = /^(and|so|but|well|now|okay|ok|um|uh|yeah|like|you know|it just so happens that|i think that|i mean)[,.]?\s+/i;
const ASIDES = /,\s*(of course|you know|i think|basically|actually|right|okay|kind of|sort of|i mean),/gi;

/** A short, truthful working title taken from the opening words (no invented claims). */
export function workingTitle(sentence: Sentence): string {
  let text = sentence.text.replace(/\s+/g, " ").trim().replace(ASIDES, "");
  for (let k = 0; k < 4; k++) text = text.replace(LEADING_FILLER, "");
  const firstClause = text.split(/[;:—]|\. /)[0] ?? text;
  const commaParts = firstClause.split(",");
  const head = commaParts[0]!.trim().split(" ").length >= 4 ? commaParts[0]! : firstClause;
  const title = head.split(" ").filter(Boolean).slice(0, 9).join(" ").replace(/[.!?,]+$/, "");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function quote(s: Sentence, max = 140): string {
  const t = s.text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function toCandidate(s: Scored, ctx: WindowContext, opts: RankOptions, id: string, strong: boolean): Candidate {
  const f = s.features;
  const sents = ctx.sentences.slice(s.window.first, s.window.last + 1);
  const first = sents[0]!;
  const last = sents[sents.length - 1]!;
  const middle = sents.length > 2 ? sents[Math.floor(sents.length / 2)]! : first;
  const evidence: Evidence[] = [
    { kind: "transcript", t: first.start, end: first.end, detail: `opens: "${quote(first)}"` },
    { kind: "transcript", t: last.start, end: last.end, detail: `ends: "${quote(last)}"` },
    ...f.audio.laughter.map((e) => ({ kind: "audio" as const, t: e.t, ...(e.end !== undefined ? { end: e.end } : {}), detail: e.detail })),
    ...f.audio.peaks.slice(0, 3).map((e) => ({ kind: "audio" as const, t: e.t, detail: `energy peak: ${e.detail}` })),
    ...(opts.visualCoverage !== "none"
      ? [{ kind: "visual-cv" as const, t: s.window.start, end: s.window.end, detail: `faces in ${Math.round(f.visual.faceFraction * 100)}% of sampled frames (max ${f.visual.maxFaces} at once); ${f.visual.sceneCuts} scene cut(s) inside` }]
      : []),
    ...f.visual.observations.map((o) => ({ kind: "visual-agent" as const, ...(o.t !== undefined ? { t: o.t } : {}), ...(o.end !== undefined ? { end: o.end } : {}), detail: `${o.kind}: ${o.detail}` })),
  ];
  const reasonsNotToUse = [
    ...s.penalties.map((p) => `${p.kind}: ${p.reason}`),
    ...(strong ? [] : [`below the quality bar (${s.total} < ${opts.qualityBar ?? 50})`]),
    ...(opts.visualCoverage === "none" ? ["no picture analysis: reactions and visual jokes are unverified"] : []),
  ];
  const linkConf = opts.speakerLinks.filter((l) => l.trackId).map((l) => l.confidence);
  const framing =
    f.visual.observations.some((o) => o.kind === "screen-demo") ? "screen-face (keep the screen readable)" :
    f.visual.maxFaces >= 2 ? "two people visible — speaker switching or dual-stack" :
    f.visual.faceFraction >= 0.5 ? "single speaker — stable full-crop" :
    f.visual.faceFraction > 0 ? "intermittent face — full-crop with fit-background fallback" : "no face — fit-background";
  const analysisLevel = f.visual.observations.length > 0 ? "audiovisual-agent" : opts.visualCoverage === "none" ? "transcript-only" : "audiovisual-cv";
  const why = [
    ...f.hook.reasons.slice(0, 2),
    ...f.payoff.reasons.slice(0, 2),
    ...f.emotion.reasons.slice(0, 1),
  ];
  const trims = [];
  for (let k = 1; k < sents.length; k++) {
    const gap = sents[k]!.start - sents[k - 1]!.end;
    if (gap > msToFlicks(1200)) trims.push({ start: sents[k - 1]!.end, end: sents[k]!.start, reason: `${(gap / 705_600_000).toFixed(1)} s pause` });
  }
  const prev = ctx.sentences[s.window.first - 1];
  // Spoken openers like "And"/"So"/"Um" are trimmed so the clip starts on content.
  const trim = openingTrim(first);
  const start = trim > 0 ? first.words[trim]!.start : s.window.start;
  if (trim > 0) trims.unshift({ start: s.window.start, end: start, reason: `dropped leading "${first.words.slice(0, trim).map((x) => x.text).join(" ")}"` });
  return {
    id,
    sourceId: opts.sourceId,
    kind: f.kind,
    start,
    end: s.window.end,
    tentativeDurationFlicks: s.window.end - start,
    title: workingTitle(first),
    hook: quote(first, 160),
    whyItHolds: why.length ? `${why.join("; ")}.` : "complete thought with a clean ending.",
    setup: { start: first.start, end: first.end, text: quote(first, 200) },
    beat: { start: middle.start, end: middle.end, text: quote(middle, 200) },
    payoff: { start: last.start, end: last.end, text: quote(last, 200) },
    evidence,
    ...(f.missingSetup && prev ? { requiredContext: `continues "${quote(prev, 120)}" (${formatTimecode(prev.start)})` } : {}),
    optionalTrims: trims,
    reasonsNotToUse,
    suggestions: {
      framing,
      captionStyleId: opts.captionStyleId,
      intensity: opts.intensity,
      ...(f.visual.coverTime !== null ? { coverTimeFlicks: f.visual.coverTime } : {}),
    },
    scores: {
      criteria: s.criteria,
      weights: { ...opts.weights },
      penalties: s.penalties,
      total: s.total,
      reasons: [`kind ${f.kind}: ${f.kindReason}`, ...f.hook.reasons, ...f.payoff.reasons, ...f.standalone.reasons, ...f.emotion.reasons, ...f.delivery.reasons, ...f.fit.reasons],
    },
    confidence: {
      transcript: Math.round((sents.reduce((a, x) => a + x.meanConfidence, 0) / sents.length) * 100) / 100,
      speakerMapping: linkConf.length ? Math.round((linkConf.reduce((a, b) => a + b, 0) / linkConf.length) * 100) / 100 : 0.3,
      visual: analysisLevel === "audiovisual-agent" ? 0.8 : analysisLevel === "audiovisual-cv" ? 0.5 : 0.1,
      editorial: Math.round((1 / (1 + Math.exp(-(s.total - (opts.qualityBar ?? 50)) / 10))) * 100) / 100,
    },
    analysisLevel,
    preview: null,
    selection: { state: strong ? "proposed" : "rejected", ...(strong ? {} : { reason: "below quality bar" }) },
  };
}

export interface Selection {
  chosen: Scored[];
  nearMisses: Scored[];
  shortfall: string | null;
}

/**
 * Greedy diverse selection: best first, no overlap beyond maxIou, a minimum gap
 * between moments, and a small preference for kinds not yet represented.
 * Never pads with weak material: windows below the bar are returned separately.
 */
export function selectMoments(scored: readonly Scored[], opts: RankOptions): Selection {
  const bar = opts.qualityBar ?? 50;
  const gap = msToFlicks(opts.minGapSec * 1000);
  const ordered = [...scored].sort((a, b) => b.total - a.total || a.window.start - b.window.start);
  const chosen: Scored[] = [];
  const kinds = new Map<string, number>();
  const conflicts = (s: Scored) =>
    chosen.some((c) => iou({ start: c.window.start, end: c.window.end }, { start: s.window.start, end: s.window.end }) > opts.maxIou || (s.window.start < c.window.end + gap && c.window.start < s.window.end + gap));
  const pool = ordered.filter((s) => s.total >= bar);
  while (chosen.length < opts.count) {
    const options = pool.filter((s) => !chosen.includes(s) && !conflicts(s));
    if (options.length === 0) break;
    const best = options[0]!;
    // Prefer an unrepresented kind when it is within 3 points of the best.
    const alt = options.find((s) => s.total >= best.total - 3 && !kinds.has(s.features.kind));
    const pick = alt ?? best;
    chosen.push(pick);
    kinds.set(pick.features.kind, (kinds.get(pick.features.kind) ?? 0) + 1);
  }
  const nearMisses = ordered.filter((s) => s.total < bar && !chosen.some((c) => iou({ start: c.window.start, end: c.window.end }, { start: s.window.start, end: s.window.end }) > 0)).slice(0, 3);
  const shortfall =
    chosen.length < opts.count
      ? `Only ${chosen.length} non-overlapping moment(s) reached the quality bar (${bar}) out of ${opts.count} requested. ${nearMisses.length ? `${nearMisses.length} weaker alternative(s) are listed as rejected so you can still choose them deliberately.` : "No weaker alternatives are offered as padding."}`
      : null;
  return { chosen, nearMisses, shortfall };
}

/** Dedup helper for repeated hooks (same normalized opening). */
export function openingKey(s: Sentence): string {
  return s.text.split(/\s+/).slice(0, 6).map(normalizeToken).join(" ");
}

export type { MomentWindow, WindowContext, WindowFeatures } from "./features.ts";
export function overlapFlicks(a: { start: Flicks; end: Flicks }, b: { start: Flicks; end: Flicks }): Flicks {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}
