import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CaptionTrackSchema, type EditPlan, type FaceTrack, type MetricsTable, type Transcript } from "../../packages/core/src/index.ts";
import { applyOps, recaption, type ReviseContext } from "../../packages/cli/src/revise/ops.ts";
import { loadCaptionStyle } from "../../packages/adapters/src/presets.ts";
import { MS, S, makePlan, sentence } from "../core/helpers.ts";

const metrics = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "assets", "fonts", "metrics.json"), "utf8")) as MetricsTable;

function transcript(): Transcript {
  return {
    schemaVersion: 1,
    sourceId: "cam",
    engine: { name: "test", version: "1", model: "x", params: {}, device: "cpu" },
    language: "en",
    languageSource: "user",
    durationFlicks: S(30),
    segments: [],
    words: [...sentence("a", "So the main reason we built this is speed.", 10.2), ...sentence("b", "And then everything else followed quickly.", 13.5)],
    speakers: [],
    diarization: null,
    createdAt: "2026-10-01T00:00:00Z",
    notes: [],
  };
}

function face(id: string, x: number): FaceTrack {
  return {
    id,
    start: S(0),
    end: S(60),
    visibility: 1,
    meanBox: { x, y: 200, w: 120, h: 160 },
    samples: Array.from({ length: 120 }, (_, i) => ({ t: S(i * 0.5), box: { x, y: 200, w: 120, h: 160 }, score: 0.9 })),
  };
}

function ctx(): ReviseContext {
  return {
    transcript: transcript(),
    visual: { schemaVersion: 1, sourceId: "cam", detector: { name: "t", model: "t", version: "1" }, sampling: { baseFps: 2, denseWindows: [], framesAnalyzed: 120, note: "" }, frame: { width: 1920, height: 1080 }, scenes: [], faceTracks: [face("T1", 700), face("T2", 1000)], speakerLinks: [], screenRegions: [], frameSheets: [], observations: [], blackIntervals: [], createdAt: "x" },
    frame: { width: 1920, height: 1080, durationFlicks: S(120) },
    styleFor: (id) => loadCaptionStyle(id),
    metrics,
    zoneFor: () => ({ y0: 1180, y1: 1460 }),
  };
}

function withCaptions(plan: EditPlan): EditPlan {
  const p = { ...plan, captions: CaptionTrackSchema.parse({ styleId: "clean", styleVersion: "1.0.0", overrides: {}, language: "en", chunks: [], delivery: { burnIn: true, srt: true, vtt: true, wordsJson: true }, minStartFlicks: 0, notes: [] }) };
  return recaption(p, ctx());
}

describe("revisions", () => {
  test("extend-end lengthens the edit, re-derives captions from the time map, and never mutates the base", () => {
    const base = withCaptions(makePlan([[10, 4]]));
    const snapshot = JSON.stringify(base);
    const lastWordsBefore = base.captions!.chunks.flatMap((c) => c.words).length;
    const { plan, invalidated } = applyOps(base, [{ op: "extend-end", ms: 2500 }], ctx(), "give the ending more time");
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(plan.version).toBe(base.version + 1);
    expect(plan.parentVersion).toBe(base.version);
    expect(plan.output.durationFlicks).toBeGreaterThanOrEqual(base.output.durationFlicks + MS(2500) - MS(20));
    expect(plan.captions!.chunks.flatMap((c) => c.words).length).toBeGreaterThan(lastWordsBefore);
    for (const c of plan.captions!.chunks) expect(c.outEnd).toBeLessThanOrEqual(plan.output.durationFlicks);
    expect(invalidated).toContain("captions");
    expect(plan.changes[0]!.reason).toContain("give the ending more time");
  });

  test("trim-end removes the words it cuts from the captions", () => {
    const base = withCaptions(makePlan([[10, 7]]));
    const { plan } = applyOps(base, [{ op: "trim-end", ms: 3000 }], ctx(), "end sooner");
    const words = plan.captions!.chunks.flatMap((c) => c.words.map((w) => w.text));
    expect(words).not.toContain("quickly.");
    expect(plan.output.durationFlicks).toBeLessThan(base.output.durationFlicks);
  });

  test("music gain is an audio-only change that keeps the voice and picture", () => {
    const base = makePlan([[10, 4]]);
    base.audio.music = { ...base.audio.music, mode: "synth", targetLufs: -24 };
    const { plan, invalidated } = applyOps(base, [{ op: "music-gain", db: -2 }], ctx(), "make the music quieter but keep the voice");
    expect(plan.audio.music.gainDb).toBe(-2);
    expect(invalidated).toEqual(["audio"]);
    expect(JSON.stringify(plan.segments)).toBe(JSON.stringify(base.segments));
    expect(JSON.stringify(plan.audio.voice)).toBe(JSON.stringify(base.audio.voice));
  });

  test("keep-both-visible reframes only the requested range", () => {
    const base = makePlan([[10, 6]]);
    const { plan } = applyOps(base, [{ op: "keep-both-visible", from: "0:02", to: "0:04", timebase: "output" }], ctx(), "keep both people visible");
    const revised = plan.layoutRuns.filter((r) => r.reason.startsWith("revision"));
    expect(revised.length).toBeGreaterThan(0);
    for (const r of revised) {
      const crop = plan.cropPaths.find((c) => c.id === r.slots[0]!.cropPathId)!;
      const b = crop.keyframes[0]!.box;
      expect(b.x).toBeLessThanOrEqual(700);
      expect(b.x + b.w).toBeGreaterThanOrEqual(1120);
    }
    // Framing outside the range is unchanged (here the original crop already holds both
    // people, so the revision reuses it for continuity instead of reframing).
    const atZero = plan.layoutRuns.find((r) => r.outStart === 0)!;
    const crop0 = plan.cropPaths.find((c) => c.id === atZero.slots[0]!.cropPathId)!;
    expect(crop0.keyframes[0]!.box).toEqual(base.cropPaths[0]!.keyframes[0]!.box);
  });

  test("keep-both-visible builds a two-shot when the existing framing excludes someone", () => {
    const base = makePlan([[10, 6]]);
    base.cropPaths[0]!.keyframes[0]!.box = { x: 300, y: 0, w: 607.5, h: 1080 };
    const { plan } = applyOps(base, [{ op: "keep-both-visible", from: "0:02", to: "0:04", timebase: "output" }], ctx(), "keep both people visible");
    const atZero = plan.layoutRuns.find((r) => r.outStart === 0)!;
    expect(plan.cropPaths.find((c) => c.id === atZero.slots[0]!.cropPathId)!.keyframes[0]!.box.x).toBe(300);
    const revised = plan.layoutRuns.find((r) => r.reason.startsWith("revision"))!;
    const b = plan.cropPaths.find((c) => c.id === revised.slots[0]!.cropPathId)!.keyframes[0]!.box;
    expect(b.x).toBeLessThanOrEqual(700);
    expect(b.x + b.w).toBeGreaterThanOrEqual(1120);
    expect(revised.outStart).toBeGreaterThan(0);
  });

  test("music gain on an edit without music is refused", () => {
    expect(() => applyOps(makePlan([[10, 4]]), [{ op: "music-gain", db: -2 }], ctx(), "quieter music")).toThrow("no music");
  });
});
