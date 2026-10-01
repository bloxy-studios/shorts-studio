import type { Flicks } from "../time.ts";
import { flicksToSeconds, msToFlicks } from "../time.ts";
import type { Interval } from "../interval.ts";
import type { FaceTrack } from "../schema/analysis.ts";

export interface ActiveSpeaker {
  /** Source-time span of the speech turn. */
  start: Flicks;
  end: Flicks;
  /** null = no reliable on-screen speaker (off-camera voice or ambiguous). */
  trackId: string | null;
  confidence: number;
  state: "on-screen" | "off-camera" | "ambiguous" | "no-face";
  evidence: string;
  /** Normalized mouth activity per visible track. */
  scores: Record<string, number>;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * Active speaker per speech turn from audiovisual evidence. Mouth activity (frame
 * difference in the mouth region) during the turn is normalized by each face's own
 * activity outside speech, so a naturally animated face is not mistaken for the
 * speaker. Diarization labels are never treated as face identities.
 */
export function detectActiveSpeakers(tracks: readonly FaceTrack[], turns: readonly Interval[], speech: readonly Interval[], opts: { minRatio?: number; minSamples?: number } = {}): ActiveSpeaker[] {
  const minRatio = opts.minRatio ?? 1.3;
  const minSamples = opts.minSamples ?? 3;
  const inSpeech = (t: Flicks) => speech.some((r) => t >= r.start && t < r.end);
  const baseline = new Map<string, number>();
  for (const tr of tracks) {
    const quiet = tr.samples.filter((s) => typeof s.mouthActivity === "number" && !inSpeech(s.t)).map((s) => s.mouthActivity!);
    const all = tr.samples.filter((s) => typeof s.mouthActivity === "number").map((s) => s.mouthActivity!);
    baseline.set(tr.id, Math.max(0.02, median(quiet.length >= 3 ? quiet : all) || 0.05));
  }
  return turns.map((turn) => {
    const visible = tracks
      .map((tr) => ({ tr, samples: tr.samples.filter((s) => s.t >= turn.start && s.t < turn.end) }))
      .filter((v) => v.samples.length >= minSamples);
    const secs = flicksToSeconds(turn.end - turn.start).toFixed(1);
    if (visible.length === 0) {
      return { start: turn.start, end: turn.end, trackId: null, confidence: 0.6, state: "no-face", evidence: `no face visible during this ${secs} s turn`, scores: {} };
    }
    const scores: Record<string, number> = {};
    for (const v of visible) {
      const act = v.samples.filter((s) => typeof s.mouthActivity === "number").map((s) => s.mouthActivity!);
      scores[v.tr.id] = Math.round((mean(act) / (baseline.get(v.tr.id) ?? 0.05)) * 100) / 100;
    }
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [bestId, best] = ranked[0]!;
    if (visible.length === 1) {
      if (best >= 1.15) return { start: turn.start, end: turn.end, trackId: bestId, confidence: Math.min(0.85, 0.55 + (best - 1) * 0.5), state: "on-screen", evidence: `only ${bestId} visible; mouth activity ${best}× its quiet baseline`, scores };
      return { start: turn.start, end: turn.end, trackId: null, confidence: 0.45, state: "off-camera", evidence: `only ${bestId} visible but its mouth is not more active than baseline (${best}×) — likely an off-camera voice`, scores };
    }
    const second = ranked[1]![1];
    const ratio = best / Math.max(second, 0.01);
    if (best < 1.12) {
      return { start: turn.start, end: turn.end, trackId: null, confidence: 0.5, state: "off-camera", evidence: `no visible mouth is more active than its own baseline (best ${best}×) — likely an off-camera voice`, scores };
    }
    if (ratio >= minRatio && best >= 1.25) {
      return { start: turn.start, end: turn.end, trackId: bestId, confidence: Math.min(0.9, 0.45 + (ratio - 1) * 0.5), state: "on-screen", evidence: `${bestId} mouth activity ${best}× baseline vs ${second}× for the next face (ratio ${ratio.toFixed(2)})`, scores };
    }
    return { start: turn.start, end: turn.end, trackId: null, confidence: 0.3, state: "ambiguous", evidence: `${visible.length} faces visible; mouth evidence too close to call (ratio ${ratio.toFixed(2)})`, scores };
  });
}

/** Speech turns from speech regions, merging tiny gaps and splitting very long turns. */
export function speechTurns(speech: readonly Interval[], opts: { mergeGapMs?: number; maxTurnMs?: number } = {}): Interval[] {
  const merge = msToFlicks(opts.mergeGapMs ?? 350);
  const maxTurn = msToFlicks(opts.maxTurnMs ?? 6000);
  const merged: Interval[] = [];
  for (const r of [...speech].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end <= merge && r.end - last.start <= maxTurn) last.end = Math.max(last.end, r.end);
    else merged.push({ start: r.start, end: r.end });
  }
  const out: Interval[] = [];
  for (const r of merged) {
    let s = r.start;
    while (r.end - s > maxTurn) {
      out.push({ start: s, end: s + maxTurn });
      s += maxTurn;
    }
    out.push({ start: s, end: r.end });
  }
  return out;
}
