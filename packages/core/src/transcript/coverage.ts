import type { Flicks } from "../time.ts";
import { msToFlicks } from "../time.ts";
import { mergeIntervals, type Interval } from "../interval.ts";
import type { Word } from "../schema/transcript.ts";

export interface TranscriptCoverage {
  speechFlicks: Flicks;
  coveredFlicks: Flicks;
  coveredFraction: number;
  /** Speech regions (merged) with no transcribed word near them. */
  uncovered: Interval[];
  /** Words with no measured speech under them (possible hallucinations). */
  outsideSpeechWordIds: string[];
}

/**
 * Cross-checks a transcript against independently measured speech activity.
 * A speech region counts as covered when any word overlaps it (± tolerance).
 */
export function transcriptCoverage(words: readonly Word[], speech: readonly Interval[], toleranceMs = 250, minRegionMs = 500): TranscriptCoverage {
  const tol = msToFlicks(toleranceMs);
  const regions = mergeIntervals([...speech], msToFlicks(150));
  const sorted = [...words].sort((a, b) => a.start - b.start);
  let speechTotal = 0;
  let covered = 0;
  const uncovered: Interval[] = [];
  let wi = 0;
  for (const r of regions) {
    const len = r.end - r.start;
    speechTotal += len;
    while (wi < sorted.length && sorted[wi]!.end < r.start - tol) wi++;
    let hit = false;
    for (let k = wi; k < sorted.length && sorted[k]!.start <= r.end + tol; k++) {
      if (sorted[k]!.end >= r.start - tol) {
        hit = true;
        break;
      }
    }
    if (hit) covered += len;
    else if (len >= msToFlicks(minRegionMs)) uncovered.push(r);
  }
  const outside: string[] = [];
  let ri = 0;
  for (const w of sorted) {
    while (ri < regions.length && regions[ri]!.end < w.start - tol) ri++;
    const r = regions[ri];
    const overlaps = r !== undefined && r.start - tol <= w.end && w.start <= r.end + tol;
    if (!overlaps) outside.push(w.id);
  }
  return {
    speechFlicks: speechTotal,
    coveredFlicks: covered,
    coveredFraction: speechTotal > 0 ? covered / speechTotal : 1,
    uncovered: mergeIntervals(uncovered, msToFlicks(1500)),
    outsideSpeechWordIds: outside,
  };
}
