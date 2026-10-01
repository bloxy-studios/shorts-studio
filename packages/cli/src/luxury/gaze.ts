import { TimeMap, msToFlicks, type Flicks, type VisualAnalysis } from "../../../core/src/index.ts";
import { gazeFromSamples, type GazeEvidence } from "../../../core/src/luxury/layout.ts";

const AT_LENS = /\b(at|into|to)\s+(the\s+)?(lens|camera)\b|eye contact/i;
const AWAY = /\baway\b|off[- ]camera|reading|looks?\s+(down|left|right|aside|off)|glanc/i;

export interface GazeSummary {
  evidence: GazeEvidence;
  samples: number;
  agentSamples: number;
  note: string;
}

/**
 * Head-orientation evidence on the output timeline: CV votes (largest face per
 * instant) plus agent gaze observations, which outrank CV where they exist.
 */
export function outputGaze(visual: VisualAnalysis | null, timeMap: TimeMap, sourceId: string): GazeSummary {
  const byTime = new Map<number, { t: Flicks; atLens: boolean; confidence: number; area: number }>();
  for (const tr of visual?.faceTracks ?? []) {
    for (const s of tr.samples) {
      if (!s.lookingAtLens) continue;
      for (const out of timeMap.srcToOut("video", sourceId, s.t)) {
        const area = s.box.w * s.box.h;
        const prev = byTime.get(out);
        if (!prev || area > prev.area) byTime.set(out, { t: out, atLens: s.lookingAtLens.value, confidence: s.lookingAtLens.confidence, area });
      }
    }
  }
  const cv = [...byTime.values()];
  const agent: Array<{ t: Flicks; atLens: boolean; confidence: number }> = [];
  for (const o of visual?.observations ?? []) {
    if (o.kind !== "gaze" || o.t === undefined) continue;
    const at = AT_LENS.test(o.detail) && !AWAY.test(o.detail) ? true : AWAY.test(o.detail) ? false : null;
    if (at === null) continue;
    const end = o.end ?? o.t + msToFlicks(500);
    for (const m of timeMap.mapSourceInterval("video", sourceId, { start: o.t, end })) {
      for (let t = m.outStart; t < m.outEnd; t += msToFlicks(100)) agent.push({ t, atLens: at, confidence: Math.max(0.9, o.confidence) });
    }
  }
  // Agent observations replace CV votes inside the intervals they cover.
  const covered = (t: Flicks) => agent.some((a) => Math.abs(a.t - t) < msToFlicks(100));
  const merged = [...cv.filter((c) => !covered(c.t)), ...agent];
  return {
    evidence: gazeFromSamples(merged, msToFlicks(400)),
    samples: merged.length,
    agentSamples: agent.length,
    note: `${cv.length} CV head-pose samples${agent.length ? ` + ${agent.length} agent gaze samples` : ""} (head orientation, not measured eye gaze)`,
  };
}
