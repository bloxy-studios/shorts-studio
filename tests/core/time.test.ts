import { describe, expect, test } from "bun:test";
import {
  FLICKS_PER_SECOND,
  flicksPerFrame,
  flicksPerSample,
  flicksToFrameIndex,
  flicksToSamples,
  formatSrtTime,
  formatTimecode,
  framesToFlicks,
  msToFlicks,
  parseRational,
  parseTimecode,
  quantizeToFrame,
  rational,
  samplesPerFrame,
  secondsToFlicks,
} from "../../packages/core/src/index.ts";

describe("flick timebase", () => {
  test("60 fps frame spans exactly 800 samples at 48 kHz", () => {
    const fps60 = rational(60);
    expect(flicksPerFrame(fps60)).toBe(11_760_000);
    expect(flicksPerSample(48_000)).toBe(14_700);
    expect(samplesPerFrame(fps60, 48_000)).toBe(800);
  });

  test("NTSC rates are exact integers, but 48 kHz samples per 29.97 frame are not", () => {
    expect(flicksPerFrame(parseRational("30000/1001"))).toBe(23_543_520);
    expect(flicksPerFrame(parseRational("24000/1001"))).toBe(29_429_400);
    expect(samplesPerFrame(parseRational("30000/1001"), 48_000)).toBeNull();
  });

  test("decimal rates snap to NTSC rationals", () => {
    expect(parseRational("29.97")).toEqual({ num: 30000, den: 1001 });
    expect(parseRational("59.94")).toEqual({ num: 60000, den: 1001 });
    expect(parseRational("25/1")).toEqual({ num: 25, den: 1 });
  });

  test("repeated frame arithmetic never drifts", () => {
    const fps = parseRational("30000/1001");
    let t = 0;
    for (let i = 0; i < 108_000; i++) t += flicksPerFrame(fps); // one hour of NTSC frames
    expect(t).toBe(framesToFlicks(108_000, fps));
    expect(flicksToFrameIndex(t, fps)).toBe(108_000);
  });

  test("quantization modes", () => {
    const fps = rational(60);
    const frame = flicksPerFrame(fps);
    const t = frame * 10 + frame / 2; // exactly half a frame
    expect(quantizeToFrame(t, fps, "floor")).toBe(frame * 10);
    expect(quantizeToFrame(t, fps, "ceil")).toBe(frame * 11);
    expect(quantizeToFrame(t, fps, "round")).toBe(frame * 11);
    expect(quantizeToFrame(frame * 10 + 1, fps, "round")).toBe(frame * 10);
    expect(flicksToSamples(msToFlicks(40), 48_000)).toBe(1920);
  });

  test("timecode parsing accepts user-facing forms", () => {
    expect(parseTimecode("18")).toBe(secondsToFlicks(18));
    expect(parseTimecode("00:18")).toBe(secondsToFlicks(18));
    expect(parseTimecode("1:02.5")).toBe(secondsToFlicks(62.5));
    expect(parseTimecode("01:02:03.250")).toBe(secondsToFlicks(3723.25));
    expect(parseTimecode("1m2s")).toBe(secondsToFlicks(62));
    expect(parseTimecode("250ms")).toBe(msToFlicks(250));
    expect(() => parseTimecode("abc")).toThrow();
  });

  test("timecode formatting", () => {
    expect(formatTimecode(secondsToFlicks(62.5))).toBe("01:02.500");
    expect(formatSrtTime(secondsToFlicks(3723.25))).toBe("01:02:03,250");
    expect(FLICKS_PER_SECOND % 48_000).toBe(0);
  });
});
