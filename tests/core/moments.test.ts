import { describe, expect, test } from "bun:test";
import { secondsToFlicks, type AudioEvent, type Word } from "../../packages/core/src/index.ts";
import { openingTrim, splitSentences } from "../../packages/core/src/moments/sentences.ts";
import { generateWindows, type WindowContext } from "../../packages/core/src/moments/features.ts";
import { scoreWindow, selectMoments, toCandidate, workingTitle, type RankOptions } from "../../packages/core/src/moments/rank.ts";

const S = secondsToFlicks;

/** Builds words for sentences laid out back to back with given gaps (seconds). */
function script(parts: Array<[string, number]>): Word[] {
  const out: Word[] = [];
  let t = 0;
  let n = 0;
  for (const [text, gapBefore] of parts) {
    t += gapBefore;
    for (const tok of text.split(" ")) {
      out.push({ id: `w${++n}`, text: tok, start: S(t), end: S(t + 0.28), confidence: 0.95, segmentId: "s", uncertain: false, flags: [] });
      t += 0.32;
    }
  }
  return out;
}

const OPTS: RankOptions = {
  sourceId: "src",
  weights: { hook: 20, payoff: 20, standalone: 20, emotion: 15, delivery: 15, fit: 10 },
  penalties: { "missing-setup": 12, "unresolved-reference": 10, "weak-delivery": 8, "misleading-truncation": 15, "poor-audio": 10, duplicate: 20, "unusable-crop": 12 },
  band: { minSec: 5, maxSec: 12 },
  maxIou: 0.15,
  minGapSec: 1,
  count: 2,
  qualityBar: 40,
  captionStyleId: "clean",
  intensity: "balanced",
  speakerLinks: [],
  visualCoverage: "none",
};

function ctxFor(words: Word[], events: AudioEvent[] = []): WindowContext {
  return { sentences: splitSentences(words), events, observations: [], faceTracks: [], scenes: [], hardBoundaries: [], faceFps: 5 };
}

describe("sentence units", () => {
  test("split at punctuation and long pauses; dummy 'it' is not a back-reference", () => {
    const s = splitSentences(script([["And it just so happens that Apollo had a twin sister.", 0], ["They named it Artemis.", 0.2], ["then a long pause follows here", 2.0]]));
    expect(s).toHaveLength(3);
    expect(s[0]!.startsWithConjunction).toBe(true);
    expect(s[0]!.startsWithReference).toBe(false);
    expect(s[1]!.startsWithReference).toBe(true);
    expect(s[2]!.gapBefore).toBeGreaterThan(S(1.5));
  });

  test("opening trim skips spoken openers but keeps content", () => {
    const [s] = splitSentences(script([["So um we built the rocket.", 0]]));
    expect(openingTrim(s!)).toBe(2);
  });
});

describe("window generation and scoring", () => {
  const words = script([
    ["Why did we go back to the moon?", 0],
    ["Because the water ice there is rocket fuel and air to breathe.", 0.3],
    ["That is the whole plan.", 0.3],
    ["But the budget is a different story.", 0.2],
  ]);

  test("windows start at sentence openings, end at sentence ends, and fit the band", () => {
    const ctx = ctxFor(words);
    const ws = generateWindows(ctx, OPTS.band);
    const starts = new Set(ctx.sentences.map((s) => s.start));
    const ends = new Set(ctx.sentences.map((s) => s.end));
    expect(ws.length).toBeGreaterThan(0);
    for (const w of ws) {
      expect(starts.has(w.start)).toBe(true);
      expect(ends.has(w.end)).toBe(true);
      const sec = (w.end - w.start) / 705_600_000;
      expect(sec).toBeGreaterThanOrEqual(5);
      expect(sec).toBeLessThanOrEqual(12);
    }
  });

  test("hard boundaries (cuts between unrelated answers) are never crossed", () => {
    const ctx = { ...ctxFor(words), hardBoundaries: [S(5.0)] };
    for (const w of generateWindows(ctx, { minSec: 1, maxSec: 30 })) expect(w.start >= S(5.0) || w.end <= S(5.2)).toBe(true);
  });

  test("a question answered inside the window scores a payoff; a qualifying 'But' next flags truncation", () => {
    const ctx = ctxFor(words);
    const ws = generateWindows(ctx, { minSec: 5, maxSec: 12 });
    const qa = ws.find((w) => w.first === 0 && w.last === 2)!;
    const sc = scoreWindow(qa, ctx, OPTS);
    expect(sc.features.payoff.reasons.join(" ")).toContain("question set up and answered");
    expect(sc.penalties.map((p) => p.kind)).toContain("misleading-truncation");
  });

  test("an opening back-reference is penalised as missing setup", () => {
    const ctx = ctxFor(script([["The rocket launched at dawn today.", 0], ["It exploded after ten seconds of flight sadly.", 0.1], ["Nobody was hurt in the end thankfully.", 0.2]]));
    const w = generateWindows(ctx, { minSec: 3, maxSec: 12 }).find((x) => x.first === 1)!;
    const kinds = scoreWindow(w, ctx, OPTS).penalties.map((p) => p.kind);
    expect(kinds).toContain("missing-setup");
    expect(kinds).toContain("unresolved-reference");
  });

  test("heuristic laughter audio alone never makes a moment 'funny'", () => {
    const ctx = ctxFor(words, [{ t: S(1), kind: "laughter-candidate", confidence: 0.5, detail: "heuristic" }]);
    const w = generateWindows(ctx, OPTS.band)[0]!;
    expect(scoreWindow(w, ctx, OPTS).features.kind).not.toBe("funny-exchange");
  });
});

describe("selection", () => {
  test("diverse, non-overlapping picks and an honest shortfall without padding", () => {
    const words = script([["Why did we go back to the moon?", 0], ["Because the water ice there is rocket fuel and air.", 0.3], ["That is the whole plan.", 0.3]]);
    const ctx = ctxFor(words);
    const scored = generateWindows(ctx, OPTS.band).map((w) => scoreWindow(w, ctx, OPTS));
    const sel = selectMoments(scored, { ...OPTS, count: 5 });
    for (let i = 0; i < sel.chosen.length; i++)
      for (let j = i + 1; j < sel.chosen.length; j++) expect(sel.chosen[i]!.window.end <= sel.chosen[j]!.window.start || sel.chosen[j]!.window.end <= sel.chosen[i]!.window.start).toBe(true);
    expect(sel.chosen.length).toBeLessThan(5);
    expect(sel.shortfall).toContain("requested");
    const c = toCandidate(sel.chosen[0]!, ctx, OPTS, "c-001", true);
    expect(c.analysisLevel).toBe("transcript-only");
    expect(c.reasonsNotToUse.join(" ")).toContain("unverified");
  });

  test("working titles come from the actual words, minus fillers and asides", () => {
    const [s1, s2] = splitSentences(script([["And it just so happens that Apollo had a twin sister.", 0], ["Water ice, of course, is life support.", 0.2]]));
    expect(workingTitle(s1!)).toBe("Apollo had a twin sister");
    expect(workingTitle(s2!)).toBe("Water ice is life support");
  });
});
