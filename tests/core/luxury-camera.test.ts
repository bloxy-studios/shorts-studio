import { describe, expect, test } from "bun:test";
import { cameraAt, ease, motionBlurAt, sampleCamera, whipMidpoint, worldTransform, type CamMove } from "../../packages/core/src/luxury/camera.ts";

const anchor = { x: 540, y: 470 };
const init = { x: 540, y: 470, s: 1 };

describe("eases", () => {
  test("GSAP-equivalent endpoints and symmetry", () => {
    for (const n of ["sine.inOut", "power2.inOut", "power3.inOut", "power3.in", "power3.out", "none"]) {
      expect(ease(n)(0)).toBeCloseTo(0, 9);
      expect(ease(n)(1)).toBeCloseTo(1, 9);
    }
    expect(ease("power3.inOut")(0.5)).toBeCloseTo(0.5, 9);
    expect(ease("power3.in")(0.5)).toBeCloseTo(0.0625, 9); // quartic
    expect(() => ease("elastic.out")).toThrow();
  });
});

describe("cameraAt", () => {
  const moves: CamMove[] = [
    { kind: "step", t0: 1, dur: 0.5, to: { x: 900, y: 470, s: 1 } },
    { kind: "whip", t0: 2, dur: 1.05, to: { x: 2200, y: 470, s: 1 } },
    { kind: "push", t0: 4, dur: 1.5, to: { x: 2200, y: 400, s: 1.5 } },
  ];
  test("holds before, lands exactly after each move", () => {
    expect(cameraAt(0.5, init, moves)).toEqual(init);
    expect(cameraAt(1.6, init, moves)).toEqual({ x: 900, y: 470, s: 1 });
    expect(cameraAt(3.2, init, moves)).toEqual({ x: 2200, y: 470, s: 1 });
    expect(cameraAt(9, init, moves)).toEqual({ x: 2200, y: 400, s: 1.5 });
  });
  test("whip reaches the spatial midpoint at its midpoint time", () => {
    const mid = whipMidpoint(moves[1]!);
    expect(mid).toBeCloseTo(2.45, 6);
    expect(cameraAt(mid, init, moves).x).toBeCloseTo((900 + 2200) / 2, 6);
  });
  test("glide changes zoom by at most the configured delta", () => {
    const g = { scaleDelta: 0.03, driftY: 0, dur: 6 };
    expect(cameraAt(0, init, [], g).s).toBeCloseTo(1, 9);
    expect(cameraAt(6, init, [], g).s).toBeCloseTo(1.03, 9);
  });
});

describe("motion blur", () => {
  test("constant pan: sigma = 0.29 × speed × shutter / fps, horizontal only", () => {
    const at = (t: number) => worldTransform({ x: 540 + 1200 * t, y: 470, s: 1 }, anchor);
    const b = motionBlurAt(1, at, 60, 0.75, 40, anchor);
    expect(b.sigma).toBeCloseTo(0.29 * 1200 * (0.75 / 60), 6);
    expect(b.sy).toBeCloseTo(0, 6);
    expect(b.speed).toBeCloseTo(1200, 3);
  });
  test("capped at 40 px; zero at rest; landing and first frames are sharp", () => {
    const frames = sampleCamera({
      frames: 240,
      fps: 60,
      init,
      moves: [{ kind: "whip", t0: 1, dur: 1.05, to: { x: 4000, y: 470, s: 1 } }],
      glide: null,
      anchor,
      shutter: 0.75,
      maxSigma: 40,
      blur: true,
    });
    expect(frames[0]!.blur.sigma).toBe(0);
    const peak = Math.max(...frames.map((f) => f.blur.sigma));
    expect(peak).toBe(40);
    expect(frames[30]!.blur.sigma).toBe(0); // before the whip
    expect(frames[200]!.blur.sigma).toBe(0); // landed
    for (const f of frames) expect(f.blur.sy).toBeCloseTo(0, 6);
  });
});
