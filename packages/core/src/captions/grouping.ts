import type { Flicks, Rational } from "../time.ts";
import { flicksToMs, flicksToSeconds, msToFlicks, quantizeToFrame, flicksPerFrame } from "../time.ts";
import type { CaptionChunk, CaptionWord } from "../schema/editplan.ts";
import type { FinalWord } from "./retime.ts";
import { endsClause, endsSentence, isFunctionWord, normalizeToken } from "./lexicon.ts";

export interface GroupingParams {
  minWords: number;
  maxWords: number;
  maxCharsPerLine: number;
  maxLines: number;
  pauseSplitMs: number;
  minChunkMs: number;
  maxChunkMs: number;
  holdAfterMs: number;
  maxReadingCps: number;
}

export interface GroupingOptions {
  fps: Rational;
  /** Earliest caption time (e.g. one frame after the cover frame). */
  minStart: Flicks;
  /** END of the output timeline; no caption may outlive it. */
  end: Flicks;
  /** Width of text in output px at the style's base size; defaults to a char-count proxy. */
  measure?: (text: string) => number;
  maxWidthPx?: number;
  caseMode?: "as-spoken" | "upper" | "lower";
  idPrefix?: string;
  /** Phrases that must not be split across chunks (names, product names). */
  keepTogether?: string[];
}

export interface GroupingIssue {
  kind: "reading-speed" | "too-wide" | "merged-same-frame" | "clamped-start" | "dropped-after-end";
  chunkId: string;
  detail: string;
}

function display(text: string, mode: GroupingOptions["caseMode"]): string {
  const t = text.trim();
  if (mode === "upper") return t.toUpperCase();
  if (mode === "lower") return t.toLowerCase();
  return t;
}

function makeFits(params: GroupingParams, opts: GroupingOptions) {
  return (texts: string[]): boolean => {
    const joined = texts.join(" ");
    const lines = balanceLines(texts, params, opts);
    if (lines.length > params.maxLines) return false;
    if (joined.length > params.maxCharsPerLine * params.maxLines) return false;
    if (opts.measure && opts.maxWidthPx) {
      return lines.every((line) => opts.measure!(line.join(" ")) <= opts.maxWidthPx!);
    }
    return lines.every((line) => line.join(" ").length <= params.maxCharsPerLine);
  };
}

/** Groups consecutive words matching a protected phrase into one unit. */
function toUnits(words: readonly FinalWord[], phrases: readonly string[]): FinalWord[][] {
  const patterns = phrases.map((p) => p.split(/\s+/).map(normalizeToken).filter(Boolean)).filter((p) => p.length > 1);
  const tokens = words.map((w) => normalizeToken(w.text));
  const units: FinalWord[][] = [];
  let i = 0;
  while (i < words.length) {
    const match = patterns
      .filter((p) => i + p.length <= words.length && p.every((t, j) => tokens[i + j] === t))
      .sort((a, b) => b.length - a.length)[0];
    const len = match ? match.length : 1;
    units.push(words.slice(i, i + len));
    i += len;
  }
  return units;
}

/** Splits words into at most maxLines lines, minimising the widest line. */
export function balanceLines(texts: string[], params: GroupingParams, opts: Pick<GroupingOptions, "measure" | "maxWidthPx">): string[][] {
  const width = (words: string[]) => (opts.measure ? opts.measure(words.join(" ")) : words.join(" ").length);
  const limit = opts.measure && opts.maxWidthPx ? opts.maxWidthPx : params.maxCharsPerLine;
  if (width(texts) <= limit || texts.length === 1 || params.maxLines === 1) return [texts];
  let best: string[][] = [texts];
  let bestWidth = Number.POSITIVE_INFINITY;
  if (params.maxLines >= 2) {
    for (let k = 1; k < texts.length; k++) {
      const a = texts.slice(0, k);
      const b = texts.slice(k);
      const w = Math.max(width(a), width(b));
      if (w < bestWidth) {
        bestWidth = w;
        best = [a, b];
      }
    }
  }
  if (bestWidth > limit && params.maxLines >= 3 && texts.length >= 3) {
    for (let i = 1; i < texts.length - 1; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const parts = [texts.slice(0, i), texts.slice(i, j), texts.slice(j)];
        const w = Math.max(...parts.map(width));
        if (w < bestWidth) {
          bestWidth = w;
          best = parts;
        }
      }
    }
  }
  return best;
}

/**
 * Groups final-timeline words into caption chunks by phrase, pause, width and
 * reading pace, then times each chunk on the output frame grid with no overlap
 * and no stale caption beyond its words (+hold) or END.
 */
export function groupCaptions(
  words: readonly FinalWord[],
  params: GroupingParams,
  opts: GroupingOptions,
): { chunks: CaptionChunk[]; issues: GroupingIssue[] } {
  const issues: GroupingIssue[] = [];
  const prefix = opts.idPrefix ?? "cc";
  const fits = makeFits(params, opts);
  const usable = words.filter((w) => w.outStart < opts.end).sort((a, b) => a.outStart - b.outStart);
  for (const w of words) {
    if (w.outStart >= opts.end) issues.push({ kind: "dropped-after-end", chunkId: "-", detail: `${w.id} "${w.text}" starts after END` });
  }

  // 1. Phrase grouping over units (protected phrases form one unit).
  const units = toUnits(usable, opts.keepTogether ?? []);
  const groups: FinalWord[][] = [];
  let cur: FinalWord[] = [];
  for (const unit of units) {
    if (cur.length > 0) {
      const prev = cur[cur.length - 1]!;
      const first = unit[0]!;
      const last = unit[unit.length - 1]!;
      const gapMs = flicksToMs(first.outStart - prev.outEnd);
      const texts = [...cur, ...unit].map((x) => display(x.text, opts.caseMode));
      const spanMs = flicksToMs(last.outEnd - cur[0]!.outStart);
      const breakHere =
        cur.length + unit.length > params.maxWords ||
        gapMs >= params.pauseSplitMs ||
        endsSentence(prev.text) ||
        (endsClause(prev.text) && cur.length >= params.minWords) ||
        spanMs > params.maxChunkMs ||
        !fits(texts);
      if (breakHere) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(...unit);
  }
  if (cur.length > 0) groups.push(cur);
  const protectedIds = new Set(units.filter((u) => u.length > 1).flatMap((u) => u.map((w) => w.id)));

  // 2. Don't strand a function word at the end of a chunk when it leads straight
  //    into the next phrase ("going to | the store" -> "going | to the store").
  for (let i = 0; i < groups.length - 1; i++) {
    const g = groups[i]!;
    const next = groups[i + 1]!;
    const last = g[g.length - 1]!;
    if (g.length < 2 || protectedIds.has(last.id) || !isFunctionWord(last.text) || endsSentence(last.text) || endsClause(last.text)) continue;
    const gapMs = flicksToMs(next[0]!.outStart - last.outEnd);
    if (gapMs >= params.pauseSplitMs || next.length >= params.maxWords) continue;
    const moved = [last, ...next];
    if (!fits(moved.map((x) => display(x.text, opts.caseMode)))) continue;
    groups[i] = g.slice(0, -1);
    groups[i + 1] = moved;
  }

  // 3. Frame-grid timing.
  const frame = flicksPerFrame(opts.fps);
  const minStart = Math.ceil(opts.minStart / frame) * frame;
  const endLimit = Math.floor(opts.end / frame) * frame;
  let starts = groups.map((g) => {
    const s = quantizeToFrame(g[0]!.outStart, opts.fps, "round");
    return Math.max(s, minStart);
  });

  // Merge groups that would appear on the same frame.
  const merged: FinalWord[][] = [];
  const mergedStarts: Flicks[] = [];
  groups.forEach((g, i) => {
    const s = starts[i]!;
    if (merged.length > 0 && s <= mergedStarts[mergedStarts.length - 1]!) {
      merged[merged.length - 1] = [...merged[merged.length - 1]!, ...g];
      issues.push({ kind: "merged-same-frame", chunkId: `${prefix}${String(merged.length).padStart(3, "0")}`, detail: `merged ${g.length} word(s) sharing a start frame` });
    } else {
      merged.push(g);
      mergedStarts.push(s);
    }
  });
  starts = mergedStarts;

  const chunks: CaptionChunk[] = [];
  merged.forEach((g, i) => {
    const id = `${prefix}${String(i + 1).padStart(3, "0")}`;
    const start = starts[i]!;
    if (g[0]!.outStart < minStart) issues.push({ kind: "clamped-start", chunkId: id, detail: `first word begins before the minimum caption time` });
    const nextStart = i + 1 < starts.length ? starts[i + 1]! : endLimit;
    const natural = quantizeToFrame(g[g.length - 1]!.outEnd + msToFlicks(params.holdAfterMs), opts.fps, "round");
    let end = Math.min(natural, nextStart, endLimit);
    const minEnd = start + msToFlicks(params.minChunkMs);
    if (end < minEnd) end = Math.min(quantizeToFrame(minEnd, opts.fps, "ceil"), nextStart, endLimit);
    if (end <= start) end = Math.min(start + frame, nextStart, endLimit);
    if (end <= start) return;

    const texts = g.map((w) => display(w.text, opts.caseMode));
    const lines = balanceLines(texts, params, opts);
    let cursor = 0;
    const lineIds = lines.map((line) => {
      const ids = g.slice(cursor, cursor + line.length).map((w) => w.id);
      cursor += line.length;
      return ids;
    });
    const captionWords: CaptionWord[] = g.map((w) => ({
      id: w.id,
      sourceWordId: w.sourceWordId,
      text: w.text,
      display: display(w.text, opts.caseMode),
      outStart: w.outStart,
      outEnd: w.outEnd,
      emphasis: "none",
      uncertain: w.uncertain,
    }));
    const cps = texts.join(" ").length / Math.max(flicksToSeconds(end - start), 1e-6);
    if (cps > params.maxReadingCps) {
      issues.push({ kind: "reading-speed", chunkId: id, detail: `${cps.toFixed(1)} chars/s exceeds ${params.maxReadingCps}` });
    }
    if (opts.measure && opts.maxWidthPx && lines.some((l) => opts.measure!(l.join(" ")) > opts.maxWidthPx!)) {
      issues.push({ kind: "too-wide", chunkId: id, detail: "a single word exceeds the caption width; renderer must scale it down" });
    }
    chunks.push({ id, outStart: start, outEnd: end, words: captionWords, lines: lineIds });
  });

  return { chunks, issues };
}
