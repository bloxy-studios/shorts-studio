import type { Flicks } from "../time.ts";
import type { TimeMap } from "../timemap.ts";
import type { Word } from "../schema/transcript.ts";

/** A word placed on the final timeline, traceable to its source word. */
export interface FinalWord {
  id: string;
  sourceWordId: string;
  text: string;
  outStart: Flicks;
  outEnd: Flicks;
  confidence: number;
  uncertain: boolean;
  /** True when the edit presents only part of the word's audio. */
  partial: boolean;
  speaker?: string;
}

export interface DroppedWord {
  sourceWordId: string;
  text: string;
  reason: "not-in-edit" | "mostly-cut";
}

export interface RetimeResult {
  words: FinalWord[];
  dropped: DroppedWord[];
}

/**
 * Retimes source transcript words onto the output using the explicit audio time
 * map of the voice source. Captions must be derived from this, never from the
 * original transcript timings.
 *
 * A word that is only partly present is kept (flagged `partial`) when at least
 * `minPresentFraction` of it survives; otherwise it is dropped and reported.
 */
export function retimeWords(
  words: readonly Word[],
  map: TimeMap,
  voiceSourceId: string,
  opts: { minPresentFraction?: number; idPrefix?: string } = {},
): RetimeResult {
  const minPresent = opts.minPresentFraction ?? 0.6;
  const prefix = opts.idPrefix ?? "fw";
  const placed: Omit<FinalWord, "id">[] = [];
  const dropped: DroppedWord[] = [];

  for (const w of words) {
    const len = w.end - w.start;
    if (len <= 0) continue;
    const mapped = map.mapSourceInterval("audio", voiceSourceId, { start: w.start, end: w.end });
    if (mapped.length === 0) {
      dropped.push({ sourceWordId: w.id, text: w.text, reason: "not-in-edit" });
      continue;
    }
    // A word can be presented more than once only if the edit reuses source audio.
    // Overlapping audio pieces (J-cut tails) can both cover the same word; keep
    // the occurrence that presents the most of it, then any disjoint reuse.
    const occurrences = [...mapped].sort((a, b) => b.outEnd - b.outStart - (a.outEnd - a.outStart));
    const kept: typeof mapped = [];
    for (const occ of occurrences) {
      if (kept.some((k) => occ.outStart < k.outEnd && k.outStart < occ.outEnd)) continue;
      kept.push(occ);
    }
    for (const occ of kept) {
      const present = (occ.outEnd - occ.outStart) / len;
      if (occ.partial && present < minPresent) {
        dropped.push({ sourceWordId: w.id, text: w.text, reason: "mostly-cut" });
        continue;
      }
      placed.push({
        sourceWordId: w.id,
        text: w.text,
        outStart: occ.outStart,
        outEnd: occ.outEnd,
        confidence: w.confidence,
        uncertain: w.uncertain || w.confidence < 0.5,
        partial: occ.partial,
        ...(w.speaker ? { speaker: w.speaker } : {}),
      });
    }
  }

  placed.sort((a, b) => a.outStart - b.outStart || a.outEnd - b.outEnd);
  const out: FinalWord[] = placed.map((w, i) => ({ id: `${prefix}${String(i + 1).padStart(4, "0")}`, ...w }));
  return { words: out, dropped };
}
