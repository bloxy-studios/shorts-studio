/**
 * Verifies Luxury Tech motion blur on a moving test graphic (spec §16): a black/white edge
 * carried by the world camera at a constant 1200 px/s, rendered (A) at 60 fps with the
 * velocity blur and (B) at 240 fps then integrated 3-of-4 samples (0.75 shutter) to 60 fps.
 * Measures the 10–90 % edge width at rest and mid-motion against the analytic expectation.
 *   SS_DEV=1 bun tests/integration/motion-blur.verify.ts [outDir]
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MetricsTable } from "../../packages/core/src/index.ts";
import { contentZone, type CompiledGraphic, type Item } from "../../packages/core/src/luxury/graphics.ts";
import { writeLuxuryComposition } from "../../packages/adapters/src/render/luxury.ts";
import { hfRender } from "../../packages/adapters/src/hyperframes.ts";
import { paths } from "../../packages/adapters/src/env.ts";
import { py } from "../../packages/adapters/src/python.ts";

const out = process.argv[2] ?? "/tmp/ss-mblur";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const metrics = JSON.parse(readFileSync(join(paths().fontsDir, "metrics.json"), "utf8")) as MetricsTable;

// Test pattern: left half black, right half white (sharp vertical edge at the centre).
const pattern = join(out, "edge.png");
await py("matte.masks", { card: { region: { x: 0, y: 0, w: 400, h: 400 }, rect: { x: 200, y: -10, w: 400, h: 420, radius: 0 }, out: pattern } });

const SPEED = 1200; // px/s, world camera, constant
const { anchor, zone } = contentZone("lt-full-visual");
const item: Item = { id: "edge", kind: "image", x: 800, y: anchor.y - 200, w: 400, h: 400, src: pattern, fit: "cover" } as Item;
const g: CompiledGraphic = {
  subject: "motion blur test",
  layout: "lt-full-visual",
  anchor,
  zone,
  init: { x: anchor.x, y: anchor.y, s: 1 },
  moves: [{ kind: "step", t0: 0.25, dur: 1.0, to: { x: anchor.x + SPEED, y: anchor.y, s: 1 }, ease: "none" }],
  actions: [],
  sounds: [],
  items: [item],
  glide: { scaleDelta: 0, driftY: 0 },
  durationS: 1.5,
  warnings: [],
};
const frames = 90;
const edgeX = (t: number) => 1000 - SPEED * Math.max(0, Math.min(1, t - 0.25)); // screen x of the edge

async function measure(video: string, label: string) {
  const idx = [5, 10, 30, 36, 42, 48];
  const r = await py<{ edges: Array<{ frame: number; width10_90: number | null; edgeX?: number; contrast: number }> }>("motion.edge", { video, frames: idx, y: anchor.y, x0: 120, x1: 1060, width: 1080, height: 1920 });
  return r.edges.map((e) => ({ ...e, label, expectedEdgeX: Math.round(edgeX(e.frame / 60)), moving: e.frame >= 16 && e.frame <= 75 }));
}

// A: velocity blur at 60 fps.
const dirA = join(out, "velocity");
mkdirSync(dirA, { recursive: true });
writeLuxuryComposition(dirA, g, { fps: 60, frames, split: false, cover: null, motionBlur: { enabled: true, shutter: 0.75, maxSigma: 40 }, subframes: 1, metrics });
await hfRender({ dir: dirA, output: join(out, "velocity.mp4"), fps: "60", format: "mp4", quality: "delivery" });
const a = await measure(join(out, "velocity.mp4"), "velocity σ");

// B: 240 fps sub-frames, integrated 3 of every 4 (0.75 shutter) in linear light.
const dirB = join(out, "subframe");
mkdirSync(dirB, { recursive: true });
writeLuxuryComposition(dirB, g, { fps: 60, frames, split: false, cover: null, motionBlur: { enabled: false, shutter: 0.75, maxSigma: 40 }, subframes: 4, metrics });
await hfRender({ dir: dirB, output: join(out, "subframe240.mp4"), fps: "240", format: "mp4", quality: "delivery" });
const integ = await py<{ frames: number; leftover: number; weights: number[] }>("motion.integrate", { input: join(out, "subframe240.mp4"), output: join(out, "subframe60.mp4"), width: 1080, height: 1920, groupSize: 4, weights: [1, 1, 1, 0], fps: "60" });
const b = await measure(join(out, "subframe60.mp4"), "240→60 (3/4)");

const sigma = 0.29 * SPEED * (0.75 / 60);
const expectedGauss = 2.563 * sigma;
const expectedBox = 0.8 * SPEED * (0.75 / 60);
const report = { speedPxPerS: SPEED, sigmaPx: sigma, expected10_90: { gaussian: expectedGauss, boxShutter: expectedBox }, integrate: integ, velocity: a, subframe: b };
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
const restA = a.filter((e) => !e.moving).map((e) => e.width10_90!);
const moveA = a.filter((e) => e.moving).map((e) => e.width10_90!);
const restB = b.filter((e) => !e.moving).map((e) => e.width10_90!);
const moveB = b.filter((e) => e.moving).map((e) => e.width10_90!);
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
console.log(`expected 10–90 % width: Gaussian σ=${sigma.toFixed(2)} → ${expectedGauss.toFixed(1)} px; ideal 0.75 box shutter → ${expectedBox.toFixed(1)} px`);
console.log(`velocity blur:  rest ${restA.map((x) => x.toFixed(1)).join(", ")} px | moving ${moveA.map((x) => x.toFixed(1)).join(", ")} px (mean ${avg(moveA).toFixed(1)})`);
console.log(`240→60 3/4:     rest ${restB.map((x) => x.toFixed(1)).join(", ")} px | moving ${moveB.map((x) => x.toFixed(1)).join(", ")} px (mean ${avg(moveB).toFixed(1)})`);
console.log(`edge positions (velocity): ${a.map((e) => `${e.frame}:${e.edgeX}/${e.expectedEdgeX}`).join(" ")}`);
