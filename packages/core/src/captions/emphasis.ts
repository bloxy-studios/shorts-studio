import type { CaptionChunk, CaptionWord } from "../schema/editplan.ts";
import { endsSentence, isFunctionWord, normalizeToken } from "./lexicon.ts";

export interface EmphasisOptions {
  mode: "none" | "current-word" | "semantic" | "cadence";
  maxWordsPerChunk: number;
  cadence?: { minNormalChunks: number; maxNormalChunks: number; maxWords: number };
  /** Words/phrases that should win emphasis (product names, key terms from the brief). */
  keywords?: string[];
  /** Restrict emphasis to keywords only (e.g. "highlight only product names"). */
  onlyKeywords?: boolean;
  /** Acoustic prominence per source word id, 0..1 (from audio analysis). */
  prominence?: ReadonlyMap<string, number>;
  minScore?: number;
  /** Semantic mode: at most this fraction of chunks get a highlight (default 0.3). */
  maxDensity?: number;
  /** Semantic mode: minimum number of plain chunks between highlights (default 1). */
  minGapChunks?: number;
}

export interface EmphasisDecision {
  chunkId: string;
  wordIds: string[];
  score: number;
  reason: string;
}

interface Scored {
  index: number;
  score: number;
  reasons: string[];
}

function keywordSpans(words: CaptionWord[], keywords: string[]): Array<{ start: number; length: number; phrase: string }> {
  const tokens = words.map((w) => normalizeToken(w.text));
  const spans: Array<{ start: number; length: number; phrase: string }> = [];
  for (const kw of keywords) {
    const parts = kw.split(/\s+/).map(normalizeToken).filter(Boolean);
    if (parts.length === 0) continue;
    for (let i = 0; i + parts.length <= tokens.length; i++) {
      if (parts.every((p, j) => tokens[i + j] === p)) spans.push({ start: i, length: parts.length, phrase: kw });
    }
  }
  return spans;
}

/** Word ids that belong to a keyword phrase, matched across chunk boundaries. */
export function keywordWordIds(chunks: readonly CaptionChunk[], keywords: readonly string[]): Set<string> {
  const all = chunks.flatMap((c) => c.words);
  const ids = new Set<string>();
  for (const span of keywordSpans(all, [...keywords])) {
    for (let j = 0; j < span.length; j++) ids.add(all[span.start + j]!.id);
  }
  return ids;
}

export function scoreWords(words: CaptionWord[], sentenceStartFlags: boolean[], opts: EmphasisOptions, keywordIds: ReadonlySet<string> = new Set()): Scored[] {
  return words.map((w, i) => {
    const reasons: string[] = [];
    const token = normalizeToken(w.text);
    if (keywordIds.has(w.id)) return { index: i, score: 1, reasons: ["keyword"] };
    if (opts.onlyKeywords || isFunctionWord(w.text) || token.length === 0) return { index: i, score: 0, reasons: ["function-or-excluded"] };
    let score = token.length >= 7 ? 0.5 : token.length >= 5 ? 0.35 : 0.2;
    reasons.push(`length ${token.length}`);
    if (/\p{N}/u.test(token)) {
      score = Math.max(score, 0.8);
      reasons.push("number");
    }
    const raw = w.text.trim().replace(/^[^\p{L}\p{N}]+/u, "");
    if (/^\p{Lu}/u.test(raw) && !sentenceStartFlags[i] && token !== "i") {
      score = Math.max(score, 0.7);
      reasons.push("proper noun / name");
    }
    const p = opts.prominence?.get(w.sourceWordId);
    if (p !== undefined) {
      score += 0.3 * p;
      reasons.push(`prominence ${p.toFixed(2)}`);
    }
    if (w.uncertain) {
      score *= 0.5;
      reasons.push("uncertain transcription");
    }
    return { index: i, score: Math.min(score, 1), reasons };
  });
}

function pickWords(chunk: CaptionChunk, scored: Scored[], maxWords: number, minScore: number): Scored[] {
  const ranked = [...scored].filter((s) => s.score >= minScore).sort((a, b) => b.score - a.score || a.index - b.index);
  const best = ranked[0];
  if (!best) return [];
  const picked = [best];
  // A second word only when it is adjacent and also strong (e.g. "Claude Code").
  if (maxWords >= 2) {
    const neighbor = ranked.find((s) => s !== best && Math.abs(s.index - best.index) === 1 && s.score >= Math.max(minScore, best.score * 0.8));
    if (neighbor) picked.push(neighbor);
  }
  return picked.sort((a, b) => a.index - b.index).filter((s) => s.index < chunk.words.length);
}

/**
 * Marks semantically meaningful words for emphasis. Function words never win.
 * Cadence mode (Luxury Tech) highlights after N normal chunks, never on two
 * consecutive chunks, and skips a turn rather than forcing a weak word.
 */
export function applyEmphasis(chunks: readonly CaptionChunk[], opts: EmphasisOptions): { chunks: CaptionChunk[]; decisions: EmphasisDecision[] } {
  const minScore = opts.minScore ?? 0.45;
  const decisions: EmphasisDecision[] = [];
  const cleared = chunks.map((c) => ({ ...c, words: c.words.map((w) => ({ ...w, emphasis: "none" as const })) }));
  if (opts.mode === "none" || opts.mode === "current-word") return { chunks: cleared, decisions };

  // Sentence-start flags across the whole track (a capital after a full stop is not a name).
  let prevEndsSentence = true;
  const flags = cleared.map((c) =>
    c.words.map((w) => {
      const flag = prevEndsSentence;
      prevEndsSentence = endsSentence(w.text);
      return flag;
    }),
  );

  const keywordIds = keywordWordIds(cleared, opts.keywords ?? []);

  if (opts.mode === "semantic") {
    // Rank every chunk's best candidate, then pick greedily: strongest first, capped by
    // density, never adjacent, never re-highlighting a word already emphasized.
    const ranked = cleared
      .map((chunk, ci) => {
        const scored = scoreWords(chunk.words, flags[ci]!, opts, keywordIds);
        const picked = pickWords(chunk, scored, opts.maxWordsPerChunk, minScore);
        return { ci, picked, score: picked.length ? Math.max(...picked.map((p) => p.score)) : 0 };
      })
      .filter((r) => r.picked.length > 0)
      .sort((a, b) => b.score - a.score || a.ci - b.ci);
    const budget = Math.max(opts.onlyKeywords ? cleared.length : 1, Math.floor(cleared.length * (opts.maxDensity ?? 0.3)));
    const gap = opts.minGapChunks ?? 1;
    const chosen = new Map<number, Scored[]>();
    const usedTokens = new Set<string>();
    for (const r of ranked) {
      if (chosen.size >= budget) break;
      if ([...chosen.keys()].some((ci) => Math.abs(ci - r.ci) <= gap && !opts.onlyKeywords)) continue;
      const tokens = r.picked.map((p) => normalizeToken(cleared[r.ci]!.words[p.index]!.text));
      if (tokens.some((t) => usedTokens.has(t)) && !opts.onlyKeywords) continue;
      chosen.set(r.ci, r.picked);
      tokens.forEach((t) => usedTokens.add(t));
    }
    const out = cleared.map((chunk, ci) => {
      const picked = chosen.get(ci);
      if (!picked) return chunk;
      const ids = new Set(picked.map((p) => chunk.words[p.index]!.id));
      decisions.push({ chunkId: chunk.id, wordIds: [...ids], score: Math.max(...picked.map((p) => p.score)), reason: picked.map((p) => p.reasons.join("+")).join(" | ") });
      return { ...chunk, words: chunk.words.map((w) => (ids.has(w.id) ? { ...w, emphasis: "highlight" as const } : w)) };
    });
    return { chunks: out, decisions };
  }

  const out: CaptionChunk[] = [];
  let normalSince = 0;
  cleared.forEach((chunk, ci) => {
    const scored = scoreWords(chunk.words, flags[ci]!, opts, keywordIds);
    const cadence = opts.cadence;
    const eligible = cadence !== undefined && normalSince >= cadence.minNormalChunks;
    const maxWords = cadence ? cadence.maxWords : opts.maxWordsPerChunk;
    const picked = eligible && maxWords > 0 ? pickWords(chunk, scored, maxWords, minScore) : [];
    if (picked.length > 0) {
      const ids = new Set(picked.map((p) => chunk.words[p.index]!.id));
      out.push({
        ...chunk,
        words: chunk.words.map((w) => (ids.has(w.id) ? { ...w, emphasis: "highlight" as const } : w)),
      });
      decisions.push({
        chunkId: chunk.id,
        wordIds: [...ids],
        score: Math.max(...picked.map((p) => p.score)),
        reason: picked.map((p) => p.reasons.join("+")).join(" | "),
      });
      normalSince = 0;
    } else {
      out.push(chunk);
      normalSince += 1;
    }
  });
  return { chunks: out, decisions };
}
