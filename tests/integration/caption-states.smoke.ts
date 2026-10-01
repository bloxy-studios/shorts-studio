/**
 * Smoke test: caption track → state plan → HyperFrames composition → lint → PNG render.
 * Usage: bun tests/integration/caption-states.smoke.ts <styleId> <outDir>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TimeMap, applyEmphasis, buildTimeMapPieces, flicksPerFrame, groupCaptions, makeMeasurer, rational, retimeWords, secondsToFlicks,
  type CaptionTrack, type MetricsTable, type Word,
} from "../../packages/core/src/index.ts";
import { loadCaptionStyle } from "../../packages/adapters/src/presets.ts";
import { paths } from "../../packages/adapters/src/env.ts";
import { planCaptionStates, writeCaptionComposition } from "../../packages/adapters/src/render/captions.ts";
import { hfLint, hfRender } from "../../packages/adapters/src/hyperframes.ts";

const styleId = process.argv[2] ?? "luxury-tech";
const outDir = process.argv[3] ?? `/tmp/ss-caption-smoke/${styleId}`;
const style = loadCaptionStyle(styleId);
const fps = rational(60);
const text = "So the main reason we built Shorts Studio is speed. Claude Code writes the tests first and everything else came later.";
const words: Word[] = text.split(" ").map((t, i) => ({ id: `w${i}`, text: t, start: secondsToFlicks(0.2 + i * 0.32), end: secondsToFlicks(0.2 + i * 0.32 + 0.27), confidence: 0.95, segmentId: "s1", uncertain: false, flags: [] }));
const end = secondsToFlicks(0.2 + words.length * 0.32 + 0.6);
const map = new TimeMap(buildTimeMapPieces([{ id: "seg1", picture: { sourceId: "cam", srcStart: 0, outStart: 0, outEnd: end, rate: { num: 1, den: 1 } }, audio: [{ id: "a1", sourceId: "cam", srcStart: 0, outStart: 0, outEnd: end, fadeInFlicks: 0, fadeOutFlicks: 0, gainDb: 0, role: "voice" }], wordIds: [] }]));
const final = retimeWords(words, map, "cam").words;
const metrics = JSON.parse(readFileSync(join(paths().fontsDir, "metrics.json"), "utf8")) as MetricsTable;
const measure = makeMeasurer(metrics, { family: style.base.family, weight: style.base.weight, style: style.base.style, sizePx: style.base.sizePx, letterSpacingEm: style.base.letterSpacingEm, strokePx: style.base.stroke?.widthPx ?? 0, upper: style.base.case === "upper", wordSpacingPx: style.base.stroke?.widthPx ?? 0 });
const { chunks, issues } = groupCaptions(final, style.grouping, { fps, minStart: flicksPerFrame(fps), end, measure, maxWidthPx: style.placement.maxWidthPx, caseMode: style.base.case, keepTogether: ["Claude Code", "Shorts Studio"] });
const { chunks: emph, decisions } = applyEmphasis(chunks, { mode: style.emphasis.mode, maxWordsPerChunk: style.emphasis.maxWordsPerChunk, ...(style.emphasis.cadence ? { cadence: style.emphasis.cadence } : {}), keywords: ["Claude Code", "Shorts Studio"] });
const track: CaptionTrack = { styleId: style.id, styleVersion: style.version, overrides: {}, language: "en", chunks: emph, delivery: { burnIn: true, srt: true, vtt: true, wordsJson: true }, minStartFlicks: flicksPerFrame(fps), notes: [] };
const frameCount = Math.round(end / flicksPerFrame(fps));
const plan = planCaptionStates(track, style, () => style.placement.zone, fps, frameCount);
console.error(`chunks=${chunks.length} states=${plan.states.length} runs=${plan.runs.length} issues=${issues.length} highlights=${decisions.map((d) => d.wordIds.length).join(",")}`);
for (const c of emph) console.error(`  ${c.id} ${c.lines.map((l) => l.length).join("+")}: ${c.words.map((w) => (w.emphasis === "highlight" ? `[${w.display}]` : w.display)).join(" ")}`);
const comp = writeCaptionComposition(join(outDir, "comp"), plan, track, style, { width: 1080, height: 1920 });
const lint = await hfLint(comp.dir);
console.error(`lint ok=${lint.ok} errors=${JSON.stringify(lint.errors)} warnings=${lint.warnings.length}`);
const t0 = performance.now();
await hfRender({ dir: comp.dir, output: join(outDir, "frames"), fps: String(comp.fps), format: "png-sequence", quality: "looks" });
console.error(`render ${((performance.now() - t0) / 1000).toFixed(1)}s for ${comp.stateCount} states`);
