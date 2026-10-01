/**
 * Visual smoke test for Luxury Tech compositions: lint + snapshots of a split run
 * (cover frame, step, whip) and a full-visual run (UI demo + checklist).
 *   SS_DEV=1 bun tests/integration/luxury-graphics.smoke.ts [outDir] [--render]
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FLICKS_PER_SECOND, type MetricsTable } from "../../packages/core/src/index.ts";
import { GraphicRunSpecSchema, compileGraphic, withCoverReveal, type RunWord } from "../../packages/core/src/luxury/graphics.ts";
import { writeLuxuryComposition } from "../../packages/adapters/src/render/luxury.ts";
import { hfLint, hfRender, hfSnapshot } from "../../packages/adapters/src/hyperframes.ts";
import { paths } from "../../packages/adapters/src/env.ts";

const out = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "/tmp/ss-lt";
const doRender = process.argv.includes("--render");
const metrics = JSON.parse(readFileSync(join(paths().fontsDir, "metrics.json"), "utf8")) as MetricsTable;
const S = FLICKS_PER_SECOND;

function words(text: string, start: number, dur: number): RunWord[] {
  const ws = text.split(" ");
  return ws.map((w, i) => ({ id: `w${i}`, text: w, start: Math.round((start + (i * dur) / ws.length) * S), end: Math.round((start + ((i + 0.8) * dur) / ws.length) * S) }));
}

const splitSpec = GraphicRunSpecSchema.parse({
  subject: "Radar that also drives cars",
  items: [
    { id: "radar", kind: "radar", x: 150, y: 150, w: 780, h: 700, label: "Landing radar" },
    { id: "car", kind: "tile", x: 1450, y: 210, w: 600, h: 600, icon: "car", label: "Autonomous cars", tone: "ink" },
    { id: "wire", kind: "connector", from: "radar", to: "car" },
  ],
  camera: [{ kind: "whip", to: "car", when: { word: "cars" } }],
});

const fvSpec = GraphicRunSpecSchema.parse({
  subject: "Ask, answer",
  items: [
    { id: "app", kind: "chat", x: 90, y: 170, w: 900, h: 640, app: "Mission planner", prompt: "Plan a landing near the south pole", typeAt: { at: 0.3 }, sendAt: { at: 1.6 }, response: "Target: Shackleton rim. Radar altimetry from 30 km.", responseAt: { at: 1.9 } },
    { id: "steps", kind: "list", x: 90, y: 870, w: 900, h: 330, title: "Proven on Earth", rows: [{ text: "Hazard-avoiding radar", mark: "check", markAt: { at: 2.9 } }, { text: "Autopilot landings", mark: "check", markAt: { at: 3.3 }, sound: false }] },
  ],
  camera: [{ kind: "push", to: "app", scale: 1.15, when: { at: 0.2 }, dur: 1.3 }, { kind: "pull", to: { x: 540, y: 675 }, scale: 1, when: { at: 2.3 }, dur: 1.2 }],
});

async function build(name: string, spec: typeof splitSpec, layout: "lt-split" | "lt-full-visual", durS: number, text: string, cover: string | null) {
  const dir = join(out, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const compiled = compileGraphic(spec, { layout, runStart: 0, runEnd: Math.round(durS * S), words: words(text, 0.2, durS - 0.4), fps: 60 });
  const g = cover ? withCoverReveal(compiled, 60) : compiled;
  const comp = writeLuxuryComposition(dir, g, { fps: 60, frames: Math.round(durS * 60), split: layout === "lt-split", cover: cover ? { title: cover } : null, motionBlur: { enabled: true, shutter: 0.75, maxSigma: 40 }, subframes: 1, metrics });
  console.log(name, { warnings: g.warnings, sounds: g.sounds.map((s) => `${s.kind}@${s.t.toFixed(2)}`), blurFrames: comp.blurFrames, peakSigma: comp.peakSigma.toFixed(1), landingSharp: comp.landingSharp, coverLines: comp.coverLines });
  const lint = await hfLint(dir);
  console.log(name, "lint", lint.ok ? "ok" : JSON.stringify(lint.errors), lint.warnings.length ? `warnings: ${JSON.stringify(lint.warnings).slice(0, 600)}` : "");
  return { dir, g, comp };
}

const a = await build("split", splitSpec, "lt-split", 4, "Radar systems that will also guide autonomous cars", "Humanity's next step is self-driving");
const b = await build("visual", fvSpec, "lt-full-visual", 4, "Ask the planner and it answers with a radar plan", null);
const t0 = performance.now();
const whipMid = a.g.moves.find((m) => m.kind === "whip")!.t0 + 0.45;
const shotsA = await hfSnapshot(a.dir, [0, 1 / 60, 0.5, whipMid - 0.12, whipMid, 3.5], join(out, "shots-split"));
const shotsB = await hfSnapshot(b.dir, [0.05, 1.2, 1.75, 2.6, 3.95], join(out, "shots-visual"));
console.log("snapshots", ((performance.now() - t0) / 1000).toFixed(1), "s", shotsA.length + shotsB.length);
if (doRender) {
  const r0 = performance.now();
  await hfRender({ dir: a.dir, output: join(out, "split.mp4"), fps: "60", format: "mp4", quality: "delivery" });
  console.log("render split 4 s @60", ((performance.now() - r0) / 1000).toFixed(1), "s");
}
