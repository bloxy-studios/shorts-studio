import { describe, expect, test } from "bun:test";
import { secondsToFlicks, type Word } from "../../packages/core/src/index.ts";
import { detectTakes, lcsRatio } from "../../packages/core/src/takes/detect.ts";

const S = secondsToFlicks;

function session(parts: Array<[string, number]>, slowFactors: Record<number, number> = {}): Word[] {
  const out: Word[] = [];
  let t = 0.5;
  let n = 0;
  parts.forEach(([text, gap], pi) => {
    t += gap;
    const per = 0.3 * (slowFactors[pi] ?? 1);
    for (const tok of text.split(" ")) {
      out.push({ id: `w${++n}`, text: tok, start: S(t), end: S(t + per * 0.85), confidence: 0.95, segmentId: "s", uncertain: false, flags: [] });
      t += per;
    }
  });
  return out;
}

describe("repeated-take detection", () => {
  test("last complete take wins; chatter and false starts are removed", () => {
    const words = session([
      ["Okay, is this recording? Alright, here we go.", 0],
      ["Most people think the hardest part is the code.", 1.0],
      ["Hmm, let me try that again.", 1.0],
      ["Most people think the hardest part is the code.", 1.0],
      ["Every feature you add is a", 0.9],
      ["Every feature you add is a promise you keep forever.", 0.8],
    ]);
    const r = detectTakes(words);
    expect(r.lines).toHaveLength(2);
    const l1 = r.lines[0]!;
    expect(l1.takes).toHaveLength(2);
    expect(l1.chosen).toBe(l1.takes[1]!);
    expect(l1.swappedFromLast).toBe(false);
    // "Okay, is this recording?" and "Alright, here we go." are separate chatter sentences.
    expect(r.removed.map((x) => x.kind)).toEqual(["chatter", "chatter", "unused-take", "chatter", "false-start"]);
  });

  test("a defective last take (stutter) swaps in the earlier clean take and reports what was rejected", () => {
    const words = session([
      ["So start small, ship it, and listen to the people who use it.", 0],
      ["Wait, one more time for the last line.", 1.0],
      ["So start small, ship it, and and listen to the the people who use it.", 1.0],
    ]);
    const r = detectTakes(words);
    expect(r.lines).toHaveLength(1);
    const l = r.lines[0]!;
    expect(l.swappedFromLast).toBe(true);
    expect(l.chosen).toBe(l.takes[0]!);
    expect(l.reason).toContain("stutter");
    expect(r.choices[0]!.takes[1]!.defects.join(" ")).toContain('"and and"');
  });

  test("a much slower last take of the same text is flagged even if the transcript is clean", () => {
    const words = session(
      [
        ["Every feature is a promise you keep.", 0],
        ["Every feature is a promise you keep.", 1.2],
      ],
      { 1: 1.4 },
    );
    const r = detectTakes(words);
    expect(r.lines[0]!.swappedFromLast).toBe(true);
    expect(r.lines[0]!.reason).toContain("longer than the cleanest take");
  });

  test("meaningful 'okay' inside a real line is not treated as chatter", () => {
    const r = detectTakes(session([["Okay so here is the plan for the launch next week.", 0]]));
    expect(r.lines).toHaveLength(1);
    expect(r.removed).toHaveLength(0);
  });

  test("parallel sentences with different content words are separate lines, not retakes", () => {
    // Real speech (NASA soundbite): rhetorical parallelism must not be cut as an alternate take.
    const r = detectTakes(session([["Cars are starting to drive themselves.", 0.4], ["Airplanes are starting to fly themselves.", 0.3]]));
    expect(r.lines).toHaveLength(2);
    expect(r.removed).toHaveLength(0);
  });

  test("LCS ratio", () => {
    expect(lcsRatio(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
    expect(lcsRatio(["a", "b"], ["a", "x", "b", "y"])).toBe(0.5);
  });
});
