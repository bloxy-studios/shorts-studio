import type { Flicks } from "../time.ts";
import { flicksToSeconds, msToFlicks, secondsToFlicks } from "../time.ts";
import { normalizeToken } from "../captions/lexicon.ts";
import type { AudioEvent, AgentObservation, FaceTrack, Scene } from "../schema/analysis.ts";
import type { MomentKind } from "../schema/candidate.ts";
import type { Sentence } from "./sentences.ts";

export interface MomentWindow {
  start: Flicks;
  end: Flicks;
  /** Inclusive sentence index range. */
  first: number;
  last: number;
}

export interface WindowContext {
  sentences: Sentence[];
  events: AudioEvent[];
  observations: AgentObservation[];
  faceTracks: FaceTrack[];
  scenes: Scene[];
  /** Times that windows must not cross (e.g. cuts between unrelated interview answers). */
  hardBoundaries: Flicks[];
  /** Face analysis sampling rate (frames per second) used to normalise visibility. */
  faceFps: number;
}

/**
 * Windows start at a sentence opening and end at a sentence end, with durations in
 * [minSec, maxSec]; up to `maxPerStart` lengths per start spread across the band.
 */
export function generateWindows(ctx: WindowContext, band: { minSec: number; maxSec: number }, maxPerStart = Number.POSITIVE_INFINITY): MomentWindow[] {
  const { sentences } = ctx;
  const out: MomentWindow[] = [];
  const min = secondsToFlicks(band.minSec);
  const max = secondsToFlicks(band.maxSec);
  const crosses = (a: Flicks, b: Flicks) => ctx.hardBoundaries.some((t) => t > a + msToFlicks(200) && t < b - msToFlicks(200));
  for (let i = 0; i < sentences.length; i++) {
    const start = sentences[i]!.start;
    const fits: MomentWindow[] = [];
    for (let j = i; j < sentences.length; j++) {
      const end = sentences[j]!.end;
      if (end - start > max) break;
      if (crosses(start, end)) break;
      if (end - start >= min) fits.push({ start, end, first: i, last: j });
    }
    if (fits.length <= maxPerStart) out.push(...fits);
    else {
      const picks = new Set<number>([0, Math.floor((fits.length - 1) / 2), fits.length - 1]);
      for (const k of [...picks].slice(0, maxPerStart)) out.push(fits[k]!);
    }
  }
  return out;
}

const SURPRISE = new Set(["actually", "never", "always", "secret", "nobody", "surprising", "surprised", "truth", "mistake", "wrong", "biggest", "first", "only", "most", "every", "impossible", "incredible", "crazy", "insane", "unbelievable", "shocking", "twin", "imagine", "turns", "whole", "entire", "history", "record", "million", "billion"]);
const EMOTION = new Set(["love", "hate", "amazing", "incredible", "scared", "afraid", "excited", "exciting", "excitement", "crazy", "beautiful", "proud", "cried", "cry", "laugh", "laughed", "funny", "shocked", "wow", "dream", "dreams", "fear", "happy", "sad", "heart", "inspire", "inspired", "inspiring", "motivated", "motivating", "passion", "awesome", "terrifying", "emotional", "goddess", "magic"]);
const CONCLUSION = ["that's why", "which means", "the answer", "the lesson", "the goal", "that's how", "in the end", "finally", "so the", "the point is", "the key", "that's the", "and that's", "the reason"];
/** Rhetorical climax patterns ("not just men … but also women", "for the first time"). */
const CLIMAX = [/\bnot (just|only)\b.+\bbut (also )?\b/i, /\bfor the first time\b/i, /\bnever before\b/i, /\bever (been|done|seen)\b/i];
const EXPLAIN = ["how", "because", "the reason", "the way", "step", "you can", "here's", "means", "so that", "in order"];
const STORY = ["i remember", "when i was", "my mom", "my dad", "my family", "i grew up", "i was not", "i was", "my life", "my entire"];
const DISAGREE = ["i disagree", "i don't agree", "that's not true", "that's not right", "that's wrong", "you're wrong", "not true", "no, no", "but actually", "i don't think so"];
const LAUGH_MARKERS = /\((?:laughs?|laughter|chuckles?)\)|\[(?:laughs?|laughter)\]|\b(?:haha+|hahaha)\b/i;
const DEMO = ["let me show", "look at", "here you can see", "as you can see", "on the screen", "click", "type"];
const UNRESOLVED = ["as i said", "like i said", "as i mentioned", "like i mentioned", "earlier", "that guy", "the other one"];

export interface WindowFeatures {
  text: string;
  words: number;
  seconds: number;
  hook: { score: number; reasons: string[] };
  payoff: { score: number; reasons: string[] };
  standalone: { score: number; reasons: string[]; unresolved: string[] };
  emotion: { score: number; reasons: string[] };
  delivery: { score: number; reasons: string[]; wordsPerSec: number; lowConfidenceShare: number; longPauses: number };
  fit: { score: number; reasons: string[] };
  audio: { laughter: AudioEvent[]; peaks: AudioEvent[]; clipping: AudioEvent[] };
  visual: { faceFraction: number; maxFaces: number; sceneCuts: number; observations: AgentObservation[]; coverTime: Flicks | null };
  missingSetup: boolean;
  truncationRisk: string | null;
  kind: MomentKind;
  kindReason: string;
}

function hasPhrase(text: string, phrases: readonly string[]): string | null {
  const t = ` ${text.toLowerCase()} `;
  return phrases.find((p) => t.includes(` ${p}`)) ?? null;
}

function tokens(text: string): string[] {
  return text.split(/\s+/).map(normalizeToken).filter(Boolean);
}

export function windowFeatures(w: MomentWindow, ctx: WindowContext, band: { minSec: number; maxSec: number }): WindowFeatures {
  const sents = ctx.sentences.slice(w.first, w.last + 1);
  const words = sents.flatMap((s) => s.words);
  const text = sents.map((s) => s.text).join(" ");
  const seconds = flicksToSeconds(w.end - w.start);
  const first = sents[0]!;
  const last = sents[sents.length - 1]!;
  const firstTokens = tokens(first.text);
  const allTokens = tokens(text);

  // Hook: opening clarity and pull.
  const hookReasons: string[] = [];
  let hook = 0.35;
  if (first.text.trim().endsWith("?")) { hook += 0.25; hookReasons.push("opens with a question"); }
  if (/\d/.test(first.text)) { hook += 0.12; hookReasons.push("number in the opening"); }
  const surpriseHits = firstTokens.filter((t) => SURPRISE.has(t));
  if (surpriseHits.length) { hook += Math.min(0.25, 0.12 * surpriseHits.length); hookReasons.push(`surprising opener (${surpriseHits.slice(0, 3).join(", ")})`); }
  if (firstTokens.includes("you") || firstTokens.includes("your")) { hook += 0.08; hookReasons.push("direct address"); }
  if (firstTokens.length > 0 && firstTokens.length <= 14) { hook += 0.1; hookReasons.push("short punchy first sentence"); }
  if (first.startsWithReference) { hook -= 0.2; hookReasons.push("opens with an unresolved reference"); }
  hook = Math.max(0, Math.min(1, hook));

  // Payoff: clean, conclusive ending.
  const payoffReasons: string[] = [];
  let payoff = 0.3;
  if (last.endsCleanly) { payoff += 0.25; payoffReasons.push("ends on a complete sentence"); }
  const concl = hasPhrase(last.text, CONCLUSION) ?? hasPhrase(sents.slice(-2).map((s) => s.text).join(" "), CONCLUSION);
  if (concl) { payoff += 0.2; payoffReasons.push(`conclusion marker "${concl}"`); }
  if (sents.some((s, k) => k < sents.length - 1 && s.text.trim().endsWith("?"))) { payoff += 0.15; payoffReasons.push("question set up and answered inside the clip"); }
  if (/\d/.test(last.text)) { payoff += 0.05; payoffReasons.push("concrete figure at the end"); }
  const climax = CLIMAX.find((re) => re.test(last.text));
  if (climax) { payoff += 0.2; payoffReasons.push("ends on a rhetorical climax"); }
  if (sents.length >= 2) { payoff += 0.05; }
  payoff = Math.max(0, Math.min(1, payoff));

  // Standalone comprehensibility.
  const unresolved: string[] = [];
  const opening = firstTokens.slice(0, 6);
  if (first.startsWithReference) unresolved.push(`opens with "${opening[0]}"`);
  const phrase = hasPhrase(text, UNRESOLVED);
  if (phrase) unresolved.push(`refers back ("${phrase}")`);
  // A leading "And/So" is trimmed by the planner; only a genuine back-reference needs setup.
  const missingSetup = first.startsWithReference && first.gapBefore < msToFlicks(700) && first.index > 0;
  let standalone = 1 - 0.25 * unresolved.length - (missingSetup ? 0.25 : 0);
  standalone = Math.max(0, Math.min(1, standalone));
  const standaloneReasons = unresolved.length || missingSetup ? [...unresolved, ...(missingSetup ? ["continues the previous sentence without a pause"] : [])] : ["understandable without earlier context"];

  // Audio evidence inside the window.
  const inWin = (e: { t: Flicks }) => e.t >= w.start && e.t < w.end;
  // The audio laughter detector is heuristic (speech also modulates at 3–7 Hz), so it only
  // counts when corroborated by a transcript marker or an inspected visual observation.
  const laughSeen = LAUGH_MARKERS.test(sents.map((s) => s.text).join(" ")) || ctx.observations.some((o) => o.kind === "laughter" && o.t !== undefined && o.t >= w.start && o.t < w.end);
  const laughter = laughSeen ? ctx.events.filter((e) => e.kind === "laughter-candidate" && inWin(e)) : [];
  const peaks = ctx.events.filter((e) => e.kind === "energy-peak" && inWin(e));
  const clipping = ctx.events.filter((e) => e.kind === "clipping" && inWin(e));
  const observations = ctx.observations.filter((o) => o.t !== undefined && o.t >= w.start && o.t < w.end);

  // Emotion / surprise / humour / novelty.
  const emoReasons: string[] = [];
  const emoHits = allTokens.filter((t) => EMOTION.has(t));
  const surpriseAll = allTokens.filter((t) => SURPRISE.has(t));
  let emotion = 0.2 + Math.min(0.3, 0.06 * emoHits.length) + Math.min(0.2, 0.04 * surpriseAll.length);
  if (emoHits.length) emoReasons.push(`emotional language (${[...new Set(emoHits)].slice(0, 4).join(", ")})`);
  if (surpriseAll.length) emoReasons.push(`novelty/surprise words (${[...new Set(surpriseAll)].slice(0, 4).join(", ")})`);
  if (/!/.test(text)) { emotion += 0.1; emoReasons.push("exclamation"); }
  if (laughter.length) { emotion += Math.min(0.2, 0.1 * laughter.length); emoReasons.push(`${laughter.length} laughter-like audio burst(s) (heuristic)`); }
  const reactions = observations.filter((o) => o.kind === "reaction" || o.kind === "laughter" || o.kind === "gesture");
  if (reactions.length) { emotion += 0.2; emoReasons.push(`visible reaction noted on inspection (${reactions.length})`); }
  emotion = Math.max(0, Math.min(1, emotion));

  // Delivery.
  const wps = words.length / Math.max(seconds, 1);
  const lowConf = words.filter((x) => x.uncertain).length / Math.max(1, words.length);
  let longPauses = 0;
  for (let k = 1; k < words.length; k++) if (words[k]!.start - words[k - 1]!.end > msToFlicks(1200)) longPauses++;
  const deliveryReasons: string[] = [];
  let delivery = wps >= 1.8 && wps <= 4.0 ? 0.75 : wps < 1.8 ? 0.45 : 0.55;
  deliveryReasons.push(`${wps.toFixed(1)} words/s`);
  delivery -= Math.min(0.3, lowConf * 1.5);
  if (lowConf > 0.05) deliveryReasons.push(`${Math.round(lowConf * 100)}% low-confidence words`);
  delivery -= Math.min(0.3, 0.1 * longPauses);
  if (longPauses) deliveryReasons.push(`${longPauses} long pause(s)`);
  if (peaks.length) { delivery += Math.min(0.15, 0.05 * peaks.length); deliveryReasons.push(`${peaks.length} energy peak(s)`); }
  if (clipping.length) { delivery -= 0.2; deliveryReasons.push("audio clipping"); }
  delivery = Math.max(0, Math.min(1, delivery));

  // Fit to the requested duration band (peak at the band centre).
  const centre = (band.minSec + band.maxSec) / 2;
  const half = (band.maxSec - band.minSec) / 2 || 1;
  const fit = Math.max(0.3, 1 - Math.abs(seconds - centre) / half * 0.5);
  const fitReasons = [`${seconds.toFixed(1)} s (band ${band.minSec}–${band.maxSec} s)`];

  // Visual coverage from face tracks (sampled CV evidence).
  const samples = ctx.faceTracks.flatMap((t) => t.samples.filter((s) => s.t >= w.start && s.t < w.end).map((s) => ({ ...s, track: t.id })));
  const sampleTimes = new Set(samples.map((s) => s.t));
  const faceFraction = Math.min(1, sampleTimes.size / Math.max(1, seconds * ctx.faceFps));
  const perTime = new Map<number, number>();
  for (const s of samples) perTime.set(s.t, (perTime.get(s.t) ?? 0) + 1);
  const maxFaces = Math.max(0, ...perTime.values());
  const sceneCuts = ctx.scenes.filter((s) => s.start > w.start && s.start < w.end).length;
  const coverPool = samples.filter((s) => s.t < w.start + (w.end - w.start) * 0.4 && s.lookingAtLens?.value);
  const cover = [...coverPool].sort((a, b) => b.score - a.score)[0] ?? samples[0] ?? null;

  // Truncation: the speaker immediately qualifies the claim after the window.
  const after = ctx.sentences[w.last + 1];
  const truncationRisk = after && after.gapBefore < msToFlicks(1000) && /^(but|however|although|except|unless|lakini)\b/i.test(after.text.trim()) ? `next sentence qualifies the claim: "${after.text.slice(0, 60)}…"` : !last.endsCleanly ? "ends without sentence punctuation" : null;

  // Kind classification (heuristic, evidence recorded).
  let kind: MomentKind = "other";
  let kindReason = "no dominant pattern";
  const lower = text.toLowerCase();
  if (laughSeen) { kind = "funny-exchange"; kindReason = "laughter in the transcript or seen on inspection"; }
  else if (observations.some((o) => o.kind === "screen-demo") || hasPhrase(lower, DEMO)) { kind = "demonstration"; kindReason = "demonstration language/screen"; }
  else if (hasPhrase(lower, DISAGREE)) { kind = "disagreement"; kindReason = "disagreement phrasing"; }
  else if (hasPhrase(lower, STORY) && emoHits.length) { kind = "emotional-story"; kindReason = "first-person story with emotional language"; }
  else if (sents.some((s, k) => k < sents.length - 1 && s.text.trim().endsWith("?")) && last.endsCleanly) { kind = "setup-payoff"; kindReason = "question answered within the clip"; }
  else if (surpriseHits.length || (surpriseAll.length >= 2 && /\d/.test(text))) { kind = "surprising-claim"; kindReason = "surprise markers"; }
  else if (hasPhrase(lower, EXPLAIN) && last.endsCleanly) { kind = "useful-explanation"; kindReason = "explanatory structure"; }
  else if (reactions.length) { kind = "reaction"; kindReason = "visible reaction"; }
  else if (words.length <= 40 && concl) { kind = "quotable-insight"; kindReason = "short conclusive statement"; }

  return {
    text,
    words: words.length,
    seconds,
    hook: { score: hook, reasons: hookReasons },
    payoff: { score: payoff, reasons: payoffReasons },
    standalone: { score: standalone, reasons: standaloneReasons, unresolved },
    emotion: { score: emotion, reasons: emoReasons },
    delivery: { score: delivery, reasons: deliveryReasons, wordsPerSec: wps, lowConfidenceShare: lowConf, longPauses },
    fit: { score: fit, reasons: fitReasons },
    audio: { laughter, peaks, clipping },
    visual: { faceFraction, maxFaces, sceneCuts, observations, coverTime: cover ? cover.t : null },
    missingSetup,
    truncationRisk,
    kind,
    kindReason,
  };
}
