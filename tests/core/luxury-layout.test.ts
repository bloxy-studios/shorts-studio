import { describe, expect, test } from "bun:test";
import { FLICKS_PER_SECOND, isFrameAligned, rational } from "../../packages/core/src/index.ts";
import { gazeFromSamples, planLuxuryLayout, type LtLine } from "../../packages/core/src/luxury/layout.ts";

const S = FLICKS_PER_SECOND;
const fps = rational(60);

/** Lines of evenly spaced words; each line's picture spans [start, end). */
function makeLines(specs: Array<{ words: number; dur: number; intent?: LtLine["intent"]; text?: string }>): LtLine[] {
  let t = 0;
  let n = 0;
  return specs.map((spec, i) => {
    const start = t;
    const end = t + spec.dur * S;
    const step = (end - start) / spec.words;
    const texts = spec.text?.split(" ") ?? [];
    const words = Array.from({ length: spec.words }, (_, k) => ({
      id: `w${String(++n).padStart(4, "0")}`,
      start: Math.round(start + k * step + 0.05 * S),
      end: Math.round(start + (k + 0.8) * step),
      text: texts[k] ?? (k === spec.words - 1 ? "end." : "word"),
    }));
    t = end;
    return { id: `L${i + 1}`, start, end, words, ...(spec.intent ? { intent: spec.intent } : {}) };
  });
}

function samples(end: number, atLens: (t: number) => boolean) {
  const out = [];
  for (let t = 0; t < end; t += 0.1 * S) out.push({ t: Math.round(t), atLens: atLens(t), confidence: 0.8 });
  return out;
}

const base = { fps, maxRunFlicks: 8 * S, minRunFlicks: 1.2 * S };

describe("planLuxuryLayout", () => {
  test("hook → split, alternating body, outro → full camera; all three layouts, no repeats", () => {
    const lines = makeLines([{ words: 10, dur: 4 }, { words: 8, dur: 3 }, { words: 9, dur: 3.5 }, { words: 10, dur: 4 }]);
    const end = lines[lines.length - 1]!.end;
    const res = planLuxuryLayout({ ...base, lines, end, gaze: gazeFromSamples(samples(end, () => true), 0.4 * S) });
    expect(res.runs.map((r) => r.layout)).toEqual(["lt-split", "lt-full-visual", "lt-split", "lt-full-camera"]);
    expect(res.runs[0]!.role).toBe("hook");
    expect(res.runs[3]!.role).toBe("outro");
    expect(res.exceptions).toEqual([]);
  });

  test("camera is withheld while the presenter looks away, and the exception is logged", () => {
    const lines = makeLines([{ words: 10, dur: 4 }, { words: 8, dur: 3 }, { words: 10, dur: 4 }]);
    const end = lines[lines.length - 1]!.end;
    const res = planLuxuryLayout({ ...base, lines, end, gaze: gazeFromSamples(samples(end, () => false), 0.4 * S) });
    expect(res.runs.every((r) => r.layout === "lt-full-visual")).toBe(true);
    expect(res.exceptions.some((e) => e.includes("looks away"))).toBe(true);
    expect(res.exceptions.some((e) => e.includes("full-camera not used") || e.includes("layout full-camera not used"))).toBe(true);
  });

  test("a mid-line head turn splits at a word gap before the turn; remainder is a full visual", () => {
    const lines = makeLines([{ words: 10, dur: 4 }, { words: 8, dur: 3 }, { words: 12, dur: 5, intent: "opinion" }, { words: 10, dur: 4 }]);
    const end = lines[lines.length - 1]!.end;
    const turn = lines[2]!.start + 2.6 * S;
    const res = planLuxuryLayout({ ...base, lines, end, gaze: gazeFromSamples(samples(end, (t) => t < turn || t >= lines[3]!.start), 0.4 * S) });
    const cam = res.runs.find((r) => r.lineIds.includes("L3") && r.layout === "lt-full-camera")!;
    const vis = res.runs.find((r) => r.lineIds.includes("L3") && r.start === cam.end)!;
    expect(vis.layout).toBe("lt-full-visual");
    expect(cam.end).toBeLessThanOrEqual(turn);
    expect(isFrameAligned(cam.end, fps)).toBe(true);
    // The cut lies in a gap: no word straddles it.
    for (const w of lines[2]!.words) expect(w.start < cam.end && w.end > cam.end).toBe(false);
  });

  test("runs longer than ~8 s are split at a word boundary with an alternate layout", () => {
    const lines = makeLines([{ words: 10, dur: 4 }, { words: 30, dur: 12 }, { words: 10, dur: 4 }]);
    const end = lines[lines.length - 1]!.end;
    const res = planLuxuryLayout({ ...base, lines, end, gaze: gazeFromSamples(samples(end, () => true), 0.4 * S) });
    for (const r of res.runs) expect(r.end - r.start).toBeLessThanOrEqual(8.5 * S);
    for (let i = 1; i < res.runs.length; i++) expect(res.runs[i]!.layout).not.toBe(res.runs[i - 1]!.layout);
  });

  test("runs tile [0, END) exactly", () => {
    const lines = makeLines([{ words: 6, dur: 2.2 }, { words: 5, dur: 1.9 }, { words: 14, dur: 6.1 }, { words: 4, dur: 1.5 }, { words: 9, dur: 3.3 }]);
    const end = lines[lines.length - 1]!.end + 0.3 * S;
    const res = planLuxuryLayout({ ...base, lines, end, gaze: gazeFromSamples(samples(end, (t) => t % (3 * S) < 2.2 * S), 0.4 * S) });
    expect(res.runs[0]!.start).toBe(0);
    expect(res.runs[res.runs.length - 1]!.end).toBe(end);
    for (let i = 1; i < res.runs.length; i++) expect(res.runs[i]!.start).toBe(res.runs[i - 1]!.end);
    for (const r of res.runs) expect(r.end - r.start).toBeGreaterThanOrEqual(1.2 * S);
  });
});
