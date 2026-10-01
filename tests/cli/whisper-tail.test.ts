import { describe, expect, test } from "bun:test";
import { msToFlicks, secondsToFlicks, type Word } from "../../packages/core/src/index.ts";
import { constrainChunkTail } from "../../packages/adapters/src/asr/whispercpp.ts";

const w = (text: string, a: number, b: number): Word => ({ id: text, text, start: secondsToFlicks(a), end: secondsToFlicks(b), confidence: 0.9, segmentId: "s", uncertain: false, flags: [] });

describe("constrainChunkTail", () => {
  test("re-times words that overrun the measured speech end (real whisper.cpp drift)", () => {
    // Measured on the creator-luxury mic: speech ends at 25.95 s, whisper put the
    // last words up to 0.8 s late and "systems." entirely after the chunk.
    const ws = [w("next", 24.01, 24.23), w("step", 24.76, 25.06), w("in", 25.06, 25.21), w("proving", 25.21, 25.74), w("out", 25.74, 25.96), w("these", 25.96, 26.33), w("systems.", 26.33, 27.13)];
    const n = constrainChunkTail(ws, secondsToFlicks(25.95));
    expect(n).toBeGreaterThanOrEqual(2);
    const limit = secondsToFlicks(25.95) + msToFlicks(80);
    for (let i = 0; i < ws.length; i++) {
      expect(ws[i]!.end).toBeGreaterThan(ws[i]!.start);
      expect(ws[i]!.end).toBeLessThanOrEqual(limit);
      if (i > 0) expect(ws[i]!.start).toBeGreaterThanOrEqual(ws[i - 1]!.start);
    }
    expect(ws[0]!.start).toBe(secondsToFlicks(24.01)); // untouched head
    expect(ws[ws.length - 1]!.flags).toContain("time-adjusted");
  });

  test("leaves chunks that end inside the speech alone", () => {
    const ws = [w("ship", 1.0, 1.3), w("it.", 1.3, 1.62)];
    expect(constrainChunkTail(ws, secondsToFlicks(1.6))).toBe(0);
    expect(ws[1]!.end).toBe(secondsToFlicks(1.62));
  });
});
