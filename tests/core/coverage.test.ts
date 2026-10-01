import { describe, expect, test } from "bun:test";
import { secondsToFlicks, transcriptCoverage, type Word } from "../../packages/core/src/index.ts";

const S = secondsToFlicks;
const w = (id: string, a: number, b: number): Word => ({ id, text: id, start: S(a), end: S(b), confidence: 0.9, segmentId: "s", uncertain: false, flags: [] });

describe("transcript coverage against measured speech", () => {
  test("detects speech the transcript skipped (e.g. a dropped tail)", () => {
    const speech = [
      { start: S(1), end: S(4) },
      { start: S(5), end: S(9) },
      { start: S(250), end: S(258) },
    ];
    const words = [w("a", 1.1, 1.5), w("b", 5.2, 5.6)];
    const cov = transcriptCoverage(words, speech);
    expect(cov.uncovered).toEqual([{ start: S(250), end: S(258) }]);
    expect(cov.coveredFraction).toBeCloseTo(7 / 15);
  });

  test("flags words with no speech under them as possible hallucinations", () => {
    const cov = transcriptCoverage([w("real", 1.1, 1.5), w("ghost", 30, 30.4)], [{ start: S(1), end: S(2) }]);
    expect(cov.outsideSpeechWordIds).toEqual(["ghost"]);
  });

  test("a fully covered transcript reports 100%", () => {
    const cov = transcriptCoverage([w("a", 1, 2), w("b", 2.1, 3)], [{ start: S(0.95), end: S(3.05) }]);
    expect(cov.coveredFraction).toBe(1);
    expect(cov.uncovered).toEqual([]);
  });
});
