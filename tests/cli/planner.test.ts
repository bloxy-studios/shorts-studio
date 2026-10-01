import { describe, expect, test } from "bun:test";
import { refineRange, speechSpans, staticFaceCrop } from "../../packages/cli/src/plan/clip.ts";
import { msToFlicks, secondsToFlicks, type FaceTrack, type Word } from "../../packages/core/src/index.ts";

const S = secondsToFlicks;
const w = (id: string, text: string, a: number, b: number): Word => ({ id, text, start: S(a), end: S(b), confidence: 0.95, segmentId: "s", uncertain: false, flags: [] });

const words: Word[] = [
  w("w1", "Apollo", 10.0, 10.4),
  w("w2", "had", 10.45, 10.6),
  w("w3", "a", 10.62, 10.66),
  w("w4", "twin", 10.7, 10.95),
  w("w5", "sister.", 11.0, 11.5),
  w("w6", "We're", 13.0, 13.2),
  w("w7", "sending", 13.25, 13.7),
  w("w8", "women", 13.75, 14.1),
  w("w9", "too.", 14.15, 14.6),
  w("w10", "Next", 20.0, 20.3),
];

describe("clip boundary refinement", () => {
  test("extends the end to finish the sentence (keeps the payoff)", () => {
    const r = refineRange(words, S(9.9), S(13.8), msToFlicks(80), msToFlicks(150));
    expect(r.last.id).toBe("w9");
    expect(r.adjustments.join(" ")).toContain("finish the sentence");
    expect(r.end).toBe(S(14.6) + msToFlicks(150));
  });

  test("moves the start back to the sentence opening", () => {
    const r = refineRange(words, S(10.5), S(11.6), msToFlicks(80), msToFlicks(150));
    expect(r.first.id).toBe("w1");
    expect(r.start).toBe(S(10.0) - msToFlicks(80));
  });

  test("never pre-rolls into the previous word or post-rolls into the next one", () => {
    const tight: Word[] = [w("a", "One.", 1.0, 1.5), w("b", "Two.", 1.52, 2.0), w("c", "Three.", 2.02, 2.5)];
    const r = refineRange(tight, S(1.52), S(2.0), msToFlicks(200), msToFlicks(200));
    expect(r.start).toBe(S(1.5));
    expect(r.end).toBe(S(2.02));
  });

  test("long pauses compress around the gap without touching words", () => {
    const spans = speechSpans(words, S(9.9), S(14.75), { aboveMs: 700, toMs: 280 });
    expect(spans).toHaveLength(2);
    expect(spans[0]!.end).toBe(S(11.5) + msToFlicks(140));
    expect(spans[1]!.start).toBe(S(13.0) - msToFlicks(140));
  });
});

describe("static face crop", () => {
  const track: FaceTrack = {
    id: "T1",
    start: S(0),
    end: S(10),
    visibility: 1,
    meanBox: { x: 1300, y: 300, w: 200, h: 260 },
    samples: [0, 1, 2].map((i) => ({ t: S(i), box: { x: 1300 + i, y: 300, w: 200, h: 260 }, score: 0.9, landmarks: [1350, 400, 1450, 400, 1400, 450, 1360, 500, 1440, 500] })),
  };

  test("is 9:16, inside the source, and centred on the face", () => {
    const { box } = staticFaceCrop(1920, 1080, 1080 / 1920, track, S(0), S(5), 0.1, 0.38);
    expect(box.w / box.h).toBeCloseTo(1080 / 1920, 4);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.w).toBeLessThanOrEqual(1920);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.h).toBeLessThanOrEqual(1080);
    expect(Math.abs(box.x + box.w / 2 - 1401)).toBeLessThan(2);
  });

  test("clamps at the frame edge instead of leaving the source", () => {
    const edge: FaceTrack = { ...track, samples: track.samples.map((s) => ({ ...s, box: { ...s.box, x: 1800, w: 110 } })) };
    const { box } = staticFaceCrop(1920, 1080, 1080 / 1920, edge, S(0), S(5), 0.1, 0.38);
    expect(box.x + box.w).toBeCloseTo(1920, 3);
  });

  test("falls back to a centred crop with no face", () => {
    const { box, reason } = staticFaceCrop(1920, 1080, 1080 / 1920, null, S(0), S(5), 0.1, 0.38);
    expect(box.x + box.w / 2).toBeCloseTo(960, 3);
    expect(reason).toContain("centred");
  });
});
