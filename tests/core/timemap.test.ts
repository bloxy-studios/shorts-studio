import { describe, expect, test } from "bun:test";
import {
  TimeMap,
  checkTiling,
  complement,
  iou,
  mergeIntervals,
  msToFlicks,
  secondsToFlicks,
  type TimeMapPiece,
} from "../../packages/core/src/index.ts";

const S = secondsToFlicks;
const one = { num: 1, den: 1 };

/** Two segments joined by a hard picture cut at 2.0 s with a 50 ms audio-only J-cut. */
function jcutPieces(): TimeMapPiece[] {
  const lead = msToFlicks(50);
  return [
    { id: "s1.v", track: "video", segmentId: "s1", sourceId: "cam", outStart: 0, outEnd: S(2), srcStart: S(10), rate: one },
    { id: "s1.a", track: "audio", segmentId: "s1", sourceId: "cam", outStart: 0, outEnd: S(2) + msToFlicks(120), srcStart: S(10), rate: one },
    { id: "s2.v", track: "video", segmentId: "s2", sourceId: "cam", outStart: S(2), outEnd: S(5), srcStart: S(30), rate: one },
    // incoming voice starts 50 ms before its picture, reading 50 ms earlier in the source
    { id: "s2.a", track: "audio", segmentId: "s2", sourceId: "cam", outStart: S(2) - lead, outEnd: S(5), srcStart: S(30) - lead, rate: one },
  ];
}

describe("interval tiling", () => {
  test("detects gaps, overlaps and out-of-range members", () => {
    const total = { start: 0, end: 100 };
    expect(checkTiling([{ id: "a", start: 0, end: 50 }, { id: "b", start: 50, end: 100 }], total)).toEqual([]);
    const gap = checkTiling([{ id: "a", start: 0, end: 40 }, { id: "b", start: 50, end: 100 }], total);
    expect(gap.map((i) => i.kind)).toEqual(["gap"]);
    expect(gap[0]!.amount).toBe(10);
    const overlap = checkTiling([{ id: "a", start: 0, end: 60 }, { id: "b", start: 50, end: 100 }], total);
    expect(overlap.map((i) => i.kind)).toEqual(["overlap"]);
    const outside = checkTiling([{ id: "a", start: 0, end: 120 }], total);
    expect(outside.map((i) => i.kind)).toContain("out-of-range");
    expect(checkTiling([{ id: "a", start: 0, end: 90 }], total).map((i) => i.kind)).toEqual(["gap"]);
  });

  test("merge, complement and IoU", () => {
    expect(mergeIntervals([{ start: 5, end: 9 }, { start: 0, end: 3 }, { start: 3, end: 4 }])).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 9 },
    ]);
    expect(complement([{ start: 2, end: 4 }, { start: 6, end: 8 }], { start: 0, end: 10 })).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
      { start: 8, end: 10 },
    ]);
    expect(iou({ start: 0, end: 10 }, { start: 5, end: 15 })).toBeCloseTo(5 / 15);
  });
});

describe("piecewise time map", () => {
  test("J-cut keeps lip sync: audio lead reads the same source offset as its picture", () => {
    const map = new TimeMap(jcutPieces());
    expect(map.validate()).toEqual([]);
    expect(map.syncErrors()).toEqual([]);
  });

  test("overlapping audio during the J-cut returns both active pieces", () => {
    const map = new TimeMap(jcutPieces());
    const t = S(2) - msToFlicks(20);
    const active = map.outToSrc("audio", t).map((p) => [p.pieceId, p.srcTime]);
    expect(active).toEqual([
      ["s1.a", S(10) + t],
      ["s2.a", S(30) - msToFlicks(20)],
    ]);
    // Picture is a single hard cut: exactly one video piece at any time.
    expect(map.outToSrc("video", t)).toHaveLength(1);
    expect(map.outToSrc("video", S(2))[0]!.srcTime).toBe(S(30));
  });

  test("source words map through cuts and report truncation", () => {
    const map = new TimeMap(jcutPieces());
    // word fully inside segment 2
    expect(map.mapSourceInterval("audio", "cam", { start: S(31), end: S(31.4) })).toEqual([
      { pieceId: "s2.a", segmentId: "s2", outStart: S(3), outEnd: S(3.4), partial: false },
    ]);
    // word straddling the start of segment 2's audio is partial
    const partial = map.mapSourceInterval("audio", "cam", { start: S(29.9), end: S(30.1) });
    expect(partial).toHaveLength(1);
    expect(partial[0]!.partial).toBe(true);
    // word that was cut out entirely does not map
    expect(map.mapSourceInterval("audio", "cam", { start: S(20), end: S(20.5) })).toEqual([]);
    expect(map.srcToOut("video", "cam", S(30.5))).toEqual([S(2.5)]);
  });

  test("a wrong audio offset is reported as a lip-sync error", () => {
    const pieces = jcutPieces();
    pieces[3] = { ...pieces[3]!, srcStart: pieces[3]!.srcStart + msToFlicks(40) };
    const errors = new TimeMap(pieces).syncErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.errorFlicks).toBe(-msToFlicks(40));
  });

  test("separate mic audio is checked on the camera clock", () => {
    const offset = msToFlicks(1234);
    const pieces: TimeMapPiece[] = [
      { id: "s1.v", track: "video", segmentId: "s1", sourceId: "cam", outStart: 0, outEnd: S(2), srcStart: S(10), rate: one },
      { id: "s1.m", track: "audio", segmentId: "s1", sourceId: "mic", outStart: 0, outEnd: S(2), srcStart: S(10) + offset, rate: one },
    ];
    const toClock = (sourceId: string, t: number) => (sourceId === "mic" ? { clockId: "cam", time: t - offset } : { clockId: sourceId, time: t });
    expect(new TimeMap(pieces).syncErrors(0, toClock)).toEqual([]);
    expect(new TimeMap(pieces).syncErrors(0, (sourceId, t) => ({ clockId: sourceId === "mic" ? "cam" : sourceId, time: t }))).toHaveLength(1);
  });

  test("overlapping video pieces are invalid", () => {
    const pieces = jcutPieces();
    pieces[2] = { ...pieces[2]!, outStart: S(1.9) };
    expect(new TimeMap(pieces).validate().map((i) => i.kind)).toContain("video-overlap");
  });
});
