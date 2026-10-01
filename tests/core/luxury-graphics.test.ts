import { describe, expect, test } from "bun:test";
import { FLICKS_PER_SECOND } from "../../packages/core/src/index.ts";
import { GraphicRunSpecSchema, compileGraphic, screenBox, withCoverReveal, type RunWord } from "../../packages/core/src/luxury/graphics.ts";
import { whipMidpoint } from "../../packages/core/src/luxury/camera.ts";

const S = FLICKS_PER_SECOND;
const runStart = 10 * S;

function words(text: string, from: number, step = 0.4): RunWord[] {
  return text.split(" ").map((t, i) => ({ id: `w${i}`, text: t, start: Math.round(runStart + (from + i * step) * S), end: Math.round(runStart + (from + i * step + 0.3) * S) }));
}

const ctx = (layout: "lt-split" | "lt-full-visual", ws: RunWord[], durS = 6) => ({ layout, runStart, runEnd: runStart + durS * S, words: ws, fps: 60 });

describe("compileGraphic", () => {
  const ws = words("improved radars and systems for autonomous cars", 0.2);
  const spec = GraphicRunSpecSchema.parse({
    subject: "radar to car",
    items: [
      { id: "radar", kind: "radar", x: 130, y: 255, w: 820, h: 840 },
      { id: "systems", kind: "tile", x: 1290, y: 395, w: 560, h: 560, icon: "chip" },
      { id: "car", kind: "tile", x: 2390, y: 375, w: 600, h: 600, icon: "car" },
    ],
    camera: [
      { kind: "step", to: "systems", when: { word: "systems" } },
      { kind: "whip", to: "car", when: { word: "autonomous" } },
    ],
  });

  test("word anchors resolve run-relative with the preset leads; whoosh lands on the whip midpoint", () => {
    const g = compileGraphic(spec, ctx("lt-full-visual", ws));
    const step = g.moves.find((m) => m.kind === "step")!;
    expect(step.t0).toBeCloseTo(0.2 + 3 * 0.4 - 0.25, 6); // 0.25 s before "systems"
    const whip = g.moves.find((m) => m.kind === "whip")!;
    const whoosh = g.sounds.find((s) => s.kind === "whoosh")!;
    expect(whoosh.t).toBeCloseTo(whipMidpoint(whip), 9);
    expect(whoosh.t).toBeCloseTo(0.2 + 5 * 0.4, 6); // midpoint on "autonomous"
    expect(g.sounds.filter((s) => s.kind !== "whoosh")).toEqual([]); // no SFX on steps
  });

  test("rejects a second whip, an over-limit push and unknown words", () => {
    const twoWhips = { ...spec, camera: [{ kind: "whip" as const, to: "systems", when: { word: "radars" } }, { kind: "whip" as const, to: "car", when: { word: "autonomous" } }] };
    expect(() => compileGraphic(GraphicRunSpecSchema.parse(twoWhips), ctx("lt-full-visual", ws))).toThrow(/one whip/);
    const push = { ...spec, camera: [{ kind: "push" as const, to: "radar", scale: 1.8, when: { word: "radars" } }] };
    expect(() => compileGraphic(GraphicRunSpecSchema.parse(push), ctx("lt-full-visual", ws))).toThrow(/1\.6/);
    const unknown = { ...spec, camera: [{ kind: "step" as const, to: "car", when: { word: "airplanes" } }] };
    expect(() => compileGraphic(GraphicRunSpecSchema.parse(unknown), ctx("lt-full-visual", ws))).toThrow(/not spoken/);
  });

  test("cover reveal lowers the intro graphic below y=620 on frame zero, then steps back", () => {
    const card = GraphicRunSpecSchema.parse({ subject: "hero", items: [{ id: "hero", kind: "card", x: 120, y: 150, w: 840, h: 690, title: "Benefits" }] });
    const g = withCoverReveal(compileGraphic(card, ctx("lt-split", ws, 3)), 60);
    expect(screenBox(g.items[0]!, g.init, g.anchor).y).toBeGreaterThanOrEqual(620);
    expect(g.moves[0]!.kind).toBe("step");
    expect(g.moves[0]!.t0).toBeCloseTo(1 / 60, 9);
    expect(screenBox(g.items[0]!, g.moves[0]!.to, g.anchor).y).toBeCloseTo(150, 6);
  });

  test("camera start centres the first subject; landing-frame checks use screen space", () => {
    const pair = GraphicRunSpecSchema.parse({
      subject: "pair",
      start: { to: "car" },
      items: [
        { id: "car", kind: "tile", x: 96, y: 200, w: 428, h: 560, icon: "car" },
        { id: "plane", kind: "tile", x: 556, y: 200, w: 428, h: 560, icon: "plane", enter: { word: "cars" } },
      ],
      camera: [{ kind: "step", to: { x: 540, y: 480 }, when: { word: "cars" } }],
    });
    const g = compileGraphic(pair, ctx("lt-split", ws));
    const box = screenBox(g.items[0]!, g.init, g.anchor);
    expect(box.x + box.w / 2).toBeCloseTo(540, 6);
    expect(g.warnings).toEqual([]);
    expect(g.sounds.map((s) => s.kind)).toEqual(["pop"]);
  });

  test("source page: fixed frame defaults, word-anchored pan, warning without a recorded source", () => {
    const page = GraphicRunSpecSchema.parse({ subject: "page", items: [{ id: "page", kind: "source-page", src: "/tmp/x.png", pan: [{ when: { word: "systems" }, y: 0.5 }] }] });
    const g = compileGraphic(page, ctx("lt-full-visual", ws));
    const item = g.items[0]!;
    expect([item.x, item.y, item.w, item.h]).toEqual([24, 200, 1032, 1040]);
    const pan = g.actions.find((a) => a.kind === "page-pan")!;
    expect(pan.y).toBe(0.5);
    expect(pan.t).toBeCloseTo(0.2 + 3 * 0.4 - 0.25, 6);
    expect(g.warnings.some((w) => w.includes("without a recorded source"))).toBe(true);
  });
});
