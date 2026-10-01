import { describe, expect, test } from "bun:test";
import {
  EditPlanSchema,
  buildTimeMapPieces,
  flicksPerFrame,
  materialConflicts,
  resolveLayers,
  validatePlan,
} from "../../packages/core/src/index.ts";
import { FPS60, MS, S, makePlan } from "./helpers.ts";

const frames = new Map([["cam", { width: 1920, height: 1080, durationFlicks: S(120) }]]);

describe("EditPlan invariants", () => {
  test("a well-formed plan with a J-cut validates and parses", () => {
    const plan = makePlan([
      [10, 2],
      [30, 3],
    ], { jcutLeadMs: 50 });
    expect(EditPlanSchema.safeParse(plan).success).toBe(true);
    expect(validatePlan(plan, { sourceFrames: frames }).filter((i) => i.severity === "error")).toEqual([]);
    expect(plan.output.frameCount).toBe(300);
  });

  test("a picture gap is an error", () => {
    const plan = makePlan([
      [10, 2],
      [30, 3],
    ]);
    const frame = flicksPerFrame(FPS60);
    plan.segments[1]!.picture.outStart += frame;
    plan.timeMap = buildTimeMapPieces(plan.segments);
    const codes = validatePlan(plan).map((i) => i.code);
    expect(codes).toContain("picture.gap");
    expect(codes).toContain("sync.lip");
  });

  test("a negative J-cut on the first line is rejected", () => {
    const plan = makePlan([[10, 2]]);
    plan.segments[0]!.audio[0]!.outStart = -MS(50);
    plan.segments[0]!.audio[0]!.srcStart -= MS(50);
    plan.timeMap = buildTimeMapPieces(plan.segments);
    expect(validatePlan(plan).map((i) => i.code)).toContain("audio.negative-time");
  });

  test("a stale time map is caught", () => {
    const plan = makePlan([[10, 2]]);
    plan.timeMap = plan.timeMap.map((p) => ({ ...p, srcStart: p.srcStart + 1 }));
    expect(validatePlan(plan).map((i) => i.code)).toContain("timemap.stale");
  });

  test("layout runs must tile the timeline and crops must stay inside the source", () => {
    const plan = makePlan([[10, 2]]);
    plan.layoutRuns[0]!.outEnd -= flicksPerFrame(FPS60);
    plan.cropPaths[0]!.keyframes[0]!.box.x = 1500;
    const codes = validatePlan(plan, { sourceFrames: frames }).map((i) => i.code);
    expect(codes).toContain("layout.gap");
    expect(codes).toContain("crop.bounds");
  });

  test("overlapping or stale captions are errors", () => {
    const plan = makePlan([[10, 2]]);
    const w = (id: string, s: number, e: number) => ({ id, sourceWordId: id, text: id, display: id, outStart: S(s), outEnd: S(e), emphasis: "none" as const, uncertain: false });
    plan.captions = {
      styleId: "clean",
      styleVersion: "1",
      overrides: {},
      language: "en",
      minStartFlicks: 0,
      notes: [],
      delivery: { burnIn: true, srt: true, vtt: true, wordsJson: true },
      chunks: [
        { id: "cc001", outStart: S(0.5), outEnd: S(1.2), words: [w("a", 0.5, 0.9)], lines: [["a"]] },
        { id: "cc002", outStart: S(1.0), outEnd: S(2.5), words: [w("b", 1.0, 1.4)], lines: [["b"]] },
      ],
    };
    const codes = validatePlan(plan).map((i) => i.code);
    expect(codes).toContain("captions.overlap");
    expect(codes).toContain("captions.after-end");
  });
});

describe("rule precedence", () => {
  test("user > project > preset > brief > default, with provenance", () => {
    const { merged, provenance } = resolveLayers({
      default: { values: { captions: { styleId: "clean", sizePx: 64 }, music: { mode: "none" } } },
      brief: { values: { captions: { sizePx: 70 } } },
      preset: { values: { captions: { styleId: "luxury-tech" }, framing: { footageMotion: "none" } }, hardPaths: ["framing.footageMotion"] },
      user: { values: { music: { mode: "synth" } } },
    });
    expect(merged).toEqual({ captions: { styleId: "luxury-tech", sizePx: 70 }, music: { mode: "synth" }, framing: { footageMotion: "none" } });
    expect(provenance.get("captions.styleId")!.layer).toBe("preset");
    expect(provenance.get("music.mode")!.overridden).toEqual([{ layer: "default", value: "none" }]);
  });

  test("overriding a hard preset rule is a material conflict", () => {
    const { conflicts } = resolveLayers({
      preset: { values: { framing: { footageMotion: "none" } }, hardPaths: ["framing"] },
      user: { values: { framing: { footageMotion: "energetic" } } },
    });
    expect(materialConflicts(conflicts)).toHaveLength(1);
    expect(conflicts[0]!.winner.layer).toBe("user");
  });
});
