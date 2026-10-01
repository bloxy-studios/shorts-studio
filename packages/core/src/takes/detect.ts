import type { Flicks } from "../time.ts";
import { msToFlicks } from "../time.ts";
import type { Word } from "../schema/transcript.ts";
import type { TakeChoice } from "../schema/editplan.ts";
import { isFunctionWord, normalizeToken } from "../captions/lexicon.ts";
import { splitSentences, type Sentence } from "../moments/sentences.ts";

export interface Fragment {
  id: string;
  sentence: Sentence;
  tokens: string[];
  kind: "take" | "chatter" | "false-start";
  lineId: string | null;
}

export interface TakeLine {
  id: string;
  takes: Fragment[];
  chosen: Fragment;
  defects: Record<string, string[]>;
  swappedFromLast: boolean;
  reason: string;
}

export interface TakeAnalysis {
  lines: TakeLine[];
  removed: Array<{ fragmentId: string; kind: string; text: string; start: Flicks; end: Flicks; reason: string }>;
  choices: TakeChoice[];
}

/** Multi-word setup/retake phrases: strong evidence of chatter outside the intended takes. */
const CHATTER_PHRASES = [
  "let me try that again", "try that again", "one more time", "take two", "take three", "is this recording", "are we recording",
  "here we go", "let's go again", "from the top", "start over", "let me start over", "more energy", "hold on", "let me redo",
];
/** Single words that are chatter only when nothing meaningful surrounds them. */
const CHATTER_WORDS = new Set(["okay", "ok", "alright", "right", "hmm", "um", "uh", "wait", "sorry", "cut", "again", "recording", "take", "energy", "redo", "yeah"]);

function tokensOf(s: Sentence): string[] {
  return s.words.map((w) => normalizeToken(w.text)).filter(Boolean);
}

/** Longest-common-subsequence ratio (0..1) between two token lists. */
export function lcsRatio(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length] / Math.max(a.length, b.length);
}

function isChatter(tokens: string[], text: string): boolean {
  const lower = text.toLowerCase();
  const content = tokens.filter((t) => !isFunctionWord(t));
  const chatterShare = content.filter((t) => CHATTER_WORDS.has(t)).length / Math.max(1, content.length);
  if (CHATTER_PHRASES.some((p) => lower.includes(p))) return tokens.length <= 10 || chatterShare >= 0.25;
  return content.length > 0 && content.length <= 3 && chatterShare >= 0.67;
}

/** Word-level defects that justify using an earlier take. */
export function takeDefects(f: Fragment): string[] {
  const d: string[] = [];
  const t = f.tokens;
  for (let i = 1; i < t.length; i++) if (t[i] === t[i - 1] && t[i]!.length > 0) d.push(`stutter: "${t[i]} ${t[i]}"`);
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + 2 * n <= t.length; i++) {
      const a = t.slice(i, i + n).join(" ");
      if (a === t.slice(i + n, i + 2 * n).join(" ")) d.push(`mid-sentence restart: "${a} … ${a}"`);
    }
  }
  for (const w of f.sentence.words) {
    if (/[-—]$/.test(w.text.trim())) d.push(`cut-off word "${w.text}"`);
  }
  const low = f.sentence.words.filter((w) => w.confidence < 0.4).length;
  if (low >= 2 && low / f.sentence.words.length > 0.2) d.push(`${low} low-confidence words (possible mumble/clipped speech)`);
  return [...new Set(d)];
}

/**
 * Detects repeated takes of the same line in a creator recording. Policy: the last
 * complete take wins; an earlier complete take is used only when the last one has
 * an audible word-level defect, and the swap is reported with what was rejected.
 */
export function detectTakes(words: readonly Word[], opts: { similarity?: number; windowMs?: number; pauseMs?: number } = {}): TakeAnalysis {
  const sim = opts.similarity ?? 0.6;
  const window = msToFlicks(opts.windowMs ?? 45_000);
  const sentences = splitSentences(words, opts.pauseMs ?? 600);
  const frags: Fragment[] = sentences.map((s, i) => ({ id: `f${i + 1}`, sentence: s, tokens: tokensOf(s), kind: "take", lineId: null }));
  for (const f of frags) if (isChatter(f.tokens, f.sentence.text)) f.kind = "chatter";

  // False starts: an unfinished fragment that matches the opening of a later take.
  for (let i = 0; i < frags.length; i++) {
    const a = frags[i]!;
    if (a.kind !== "take" || a.sentence.endsCleanly) continue;
    for (let j = i + 1; j < frags.length && frags[j]!.sentence.start - a.sentence.end < window; j++) {
      const b = frags[j]!;
      if (b.kind !== "take" || b.tokens.length <= a.tokens.length) continue;
      const prefix = b.tokens.slice(0, a.tokens.length);
      if (a.tokens.length >= 2 && lcsRatio(a.tokens, prefix) >= 0.7) {
        a.kind = "false-start";
        break;
      }
    }
  }

  // Group retakes into lines (union by similarity within a time window). Retakes repeat
  // the same content words; parallel sentences ("cars … drive themselves" / "airplanes …
  // fly themselves") share structure but not content, and stay separate lines.
  const parent = frags.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const content = frags.map((f) => f.tokens.filter((t) => !isFunctionWord(t)));
  const sameLine = (i: number, j: number) => {
    const all = lcsRatio(frags[i]!.tokens, frags[j]!.tokens);
    if (all >= 0.85) return true;
    return all >= sim && lcsRatio(content[i]!, content[j]!) >= 0.6;
  };
  for (let i = 0; i < frags.length; i++) {
    if (frags[i]!.kind !== "take") continue;
    for (let j = i + 1; j < frags.length && frags[j]!.sentence.start - frags[i]!.sentence.end < window; j++) {
      if (frags[j]!.kind !== "take") continue;
      if (sameLine(i, j)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, Fragment[]>();
  frags.forEach((f, i) => {
    if (f.kind !== "take") return;
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), f]);
  });

  const lines: TakeLine[] = [];
  const removed: TakeAnalysis["removed"] = [];
  [...groups.values()]
    .sort((a, b) => a[0]!.sentence.start - b[0]!.sentence.start)
    .forEach((takes, li) => {
      const id = `L${li + 1}`;
      takes.forEach((t) => (t.lineId = id));
      const maxLen = Math.max(...takes.map((t) => t.tokens.length));
      const complete = takes.filter((t) => t.sentence.endsCleanly && t.tokens.length >= Math.ceil(maxLen * 0.85));
      const pool = complete.length ? complete : takes;
      const defects: Record<string, string[]> = {};
      for (const t of takes) defects[t.id] = takeDefects(t);
      // Duration anomaly vs the line's other complete takes (whisper often drops repeated words).
      if (complete.length >= 2) {
        const durs = complete.map((t) => t.sentence.end - t.sentence.start);
        const shortest = Math.min(...durs);
        for (const t of complete) {
          const ratio = (t.sentence.end - t.sentence.start) / shortest;
          if (ratio >= 1.15) defects[t.id] = [...defects[t.id]!, `${Math.round((ratio - 1) * 100)}% longer than the cleanest take of the same line (likely repetition or hesitation)`];
        }
      }
      const last = pool[pool.length - 1]!;
      let chosen = last;
      let swapped = false;
      let reason = takes.length === 1 ? "single take" : "last complete take";
      if (defects[last.id]!.length) {
        const clean = [...pool].reverse().find((t) => t !== last && defects[t.id]!.length === 0);
        if (clean) {
          chosen = clean;
          swapped = true;
          reason = `last complete take (${last.id}) has ${defects[last.id]!.join("; ")} — using earlier clean take ${clean.id}`;
        } else reason = `last complete take kept despite ${defects[last.id]!.join("; ")} (no clean alternative)`;
      }
      for (const t of takes) if (t !== chosen) removed.push({ fragmentId: t.id, kind: "unused-take", text: t.sentence.text, start: t.sentence.start, end: t.sentence.end, reason: `alternate take of ${id}` });
      lines.push({ id, takes, chosen, defects, swappedFromLast: swapped, reason });
    });
  for (const f of frags) {
    if (f.kind === "chatter") removed.push({ fragmentId: f.id, kind: "chatter", text: f.sentence.text, start: f.sentence.start, end: f.sentence.end, reason: "setup/comment outside the intended takes" });
    if (f.kind === "false-start") removed.push({ fragmentId: f.id, kind: "false-start", text: f.sentence.text, start: f.sentence.start, end: f.sentence.end, reason: "restart of the following take" });
  }
  const choices: TakeChoice[] = lines.map((l) => ({
    lineId: l.id,
    chosenTakeId: l.chosen.id,
    takes: l.takes.map((t) => ({ id: t.id, start: t.sentence.start, end: t.sentence.end, text: t.sentence.text, complete: t.sentence.endsCleanly, defects: l.defects[t.id] ?? [] })),
    reason: l.reason,
    swappedFromLast: l.swappedFromLast,
  }));
  return { lines, removed: removed.sort((a, b) => a.start - b.start), choices };
}
