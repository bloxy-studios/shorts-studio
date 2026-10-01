import type { Flicks } from "../time.ts";
import { msToFlicks } from "../time.ts";
import type { Word } from "../schema/transcript.ts";
import { endsSentence, normalizeToken } from "../captions/lexicon.ts";

export interface Sentence {
  index: number;
  start: Flicks;
  end: Flicks;
  text: string;
  words: Word[];
  /** Opens with And/But/So/Because… — usually continues a previous thought. */
  startsWithConjunction: boolean;
  /** Opens with a pronoun/deictic that may need an antecedent (it, that, they…). */
  startsWithReference: boolean;
  endsCleanly: boolean;
  /** Silence before this sentence (from the previous sentence end). */
  gapBefore: Flicks;
  meanConfidence: number;
}

const CONJUNCTIONS = new Set(["and", "but", "so", "because", "or", "then", "also", "plus", "although", "though", "yet", "na", "lakini", "kwa", "hivyo"]);
const REFERENCES = new Set(["it", "it's", "that", "that's", "this", "these", "those", "they", "they're", "them", "he", "she", "his", "her", "there", "which", "hiyo", "huo", "hao", "yeye"]);
const FILLER_OPENERS = new Set(["um", "uh", "well", "like", "okay", "ok", "yeah", "right", "now"]);

function contentTokens(words: readonly Word[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    const t = normalizeToken(w.text);
    if (!t || (out.length === 0 && (FILLER_OPENERS.has(t) || CONJUNCTIONS.has(t)))) continue;
    out.push(t);
    if (out.length >= 3) break;
  }
  return out;
}

const DUMMY_IT_NEXT = new Set(["just", "is", "was", "turns", "seems", "happens", "takes", "looks", "feels", "doesn't", "does", "would", "will", "can"]);

/** "it just so happens", "it turns out", "there is" are not references needing an antecedent. */
function isReference(tokens: string[]): boolean {
  const [a, b] = tokens;
  if (!a || !REFERENCES.has(a)) return false;
  if ((a === "it" || a === "it's") && b && DUMMY_IT_NEXT.has(b)) return false;
  if (a === "it's" && b && ["a", "an", "the", "not", "really", "very", "so", "just", "about", "time", "true", "hard", "easy"].includes(b)) return false;
  if (a === "there" && b && ["is", "are", "was", "were", "will", "have", "has", "isn't", "aren't"].includes(b)) return false;
  return true;
}

/**
 * Splits words into sentence units at terminal punctuation or at pauses longer than
 * `pauseMs`; very long run-ons are split at their largest internal pause.
 */
export function splitSentences(words: readonly Word[], pauseMs = 700, maxSentenceMs = 25_000): Sentence[] {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const groups: Word[][] = [];
  let cur: Word[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i]!;
    cur.push(w);
    const next = sorted[i + 1];
    const gap = next ? next.start - w.end : 0;
    if (!next || endsSentence(w.text) || gap > msToFlicks(pauseMs)) {
      groups.push(cur);
      cur = [];
    }
  }
  // Split run-ons at the largest internal pause until each fits.
  const bounded: Word[][] = [];
  const stack = [...groups].reverse();
  while (stack.length) {
    const g = stack.pop()!;
    const span = g[g.length - 1]!.end - g[0]!.start;
    if (span <= msToFlicks(maxSentenceMs) || g.length < 4) {
      bounded.push(g);
      continue;
    }
    let best = 1;
    let bestGap = -1;
    for (let k = 1; k < g.length; k++) {
      const gap = g[k]!.start - g[k - 1]!.end;
      if (gap > bestGap) {
        bestGap = gap;
        best = k;
      }
    }
    stack.push(g.slice(best), g.slice(0, best));
  }
  return bounded.map((g, index) => {
    const prevEnd = index > 0 ? bounded[index - 1]![bounded[index - 1]!.length - 1]!.end : 0;
    const firstRaw = normalizeToken(g.find((w) => normalizeToken(w.text))?.text ?? "");
    const toks = contentTokens(g);
    return {
      index,
      start: g[0]!.start,
      end: g[g.length - 1]!.end,
      text: g.map((w) => w.text).join(" "),
      words: g,
      startsWithConjunction: CONJUNCTIONS.has(firstRaw) || FILLER_OPENERS.has(firstRaw),
      startsWithReference: isReference(toks),
      endsCleanly: endsSentence(g[g.length - 1]!.text),
      gapBefore: Math.max(0, g[0]!.start - prevEnd),
      meanConfidence: g.reduce((a, w) => a + w.confidence, 0) / g.length,
    };
  });
}

/**
 * Index of the first word worth opening on: skips a leading conjunction or filler
 * ("And", "So", "Um", "Well,") — a standard spoken-word trim. Returns 0 when none.
 */
export function openingTrim(sentence: Sentence): number {
  let k = 0;
  while (k < sentence.words.length - 2) {
    const t = normalizeToken(sentence.words[k]!.text);
    if (CONJUNCTIONS.has(t) || FILLER_OPENERS.has(t)) k++;
    else break;
  }
  return k;
}
