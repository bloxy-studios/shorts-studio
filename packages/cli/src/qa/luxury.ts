/**
 * Luxury Tech QA: layout intents, static footage, sharp landing frames, caption
 * zones and semantic highlights, SFX/whip rules, matte stability/alignment, ground
 * colours and the frame-zero cover — measured on the plan and the delivered frames.
 */
import { flicksPerFrame, flicksToSeconds, isFunctionWord, type EditPlan, type QAFinding, type RenderRecord, type SourceAsset } from "../../../core/src/index.ts";
import { sampleCamera } from "../../../core/src/luxury/camera.ts";
import type { CompiledGraphic } from "../../../core/src/luxury/graphics.ts";
import { loadCaptionStyle } from "../../../adapters/src/presets.ts";
import { py } from "../../../adapters/src/python.ts";
import { run } from "../../../adapters/src/proc.ts";
import { tool } from "../../../adapters/src/tools.ts";
import type { LuxuryLayers } from "../luxury/render.ts";
import type { CaptionBand } from "../render/pipeline.ts";

export type LuxuryFinding = Omit<QAFinding, "id" | "evidence" | "affects"> & { evidence?: Partial<QAFinding["evidence"]>; affects?: Partial<QAFinding["affects"]> };

/** Expected ground colour at a canvas point (mirrors the composition's radial gradient). */
export function groundAt(x: number, y: number): [number, number, number] {
  const t = Math.min(1, Math.hypot((x - 540) / (0.62 * 1080), (y - 0.36 * 1920) / (0.48 * 1920)));
  const stops: Array<[number, [number, number, number]]> = [
    [0, [255, 255, 255]],
    [0.38, [0xfb, 0xfb, 0xf9]],
    [1, [0xf3, 0xf3, 0xf0]],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i]!;
    const [p0, c0] = stops[i - 1]!;
    if (t <= p1) {
      const f = (t - p0) / (p1 - p0);
      return [0, 1, 2].map((k) => c0[k]! + (c1[k]! - c0[k]!) * f) as [number, number, number];
    }
  }
  return stops[stops.length - 1]![1];
}

async function rgbAt(video: string, frameIndex: number, points: Array<[number, number]>, W: number, H: number): Promise<Array<[number, number, number]>> {
  const r = await run([tool("ffmpeg"), "-v", "error", "-nostdin", "-i", video, "-vf", `select=eq(n\\,${frameIndex}),scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"], { timeoutMs: 300_000, binary: true });
  const buf = r.stdoutBuffer!;
  return points.map(([x, y]) => {
    // 5×5 mean to ignore codec noise.
    let r0 = 0;
    let g0 = 0;
    let b0 = 0;
    let n = 0;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const xx = Math.min(W - 1, Math.max(0, x + dx));
        const yy = Math.min(H - 1, Math.max(0, y + dy));
        const o = (yy * W + xx) * 3;
        r0 += buf[o]!;
        g0 += buf[o + 1]!;
        b0 += buf[o + 2]!;
        n++;
      }
    return [r0 / n, g0 / n, b0 / n] as [number, number, number];
  });
}

export async function luxuryChecks(input: { plan: EditPlan; record: RenderRecord; captions: CaptionBand | null; video: string; luxury: LuxuryLayers | null; sources: Map<string, SourceAsset> }): Promise<LuxuryFinding[]> {
  const { plan, captions, video, luxury } = input;
  if (!plan.layoutRuns.some((r) => r.layout.startsWith("lt-"))) return [];
  const out: LuxuryFinding[] = [];
  const frame = flicksPerFrame(plan.output.fps);
  const fps = plan.output.fps.num / plan.output.fps.den;
  const W = plan.output.width;
  const H = plan.output.height;

  // L1: layout intents and sequencing.
  const count = (l: string) => plan.layoutRuns.filter((r) => r.layout === l).length;
  const used = ["lt-split", "lt-full-visual", "lt-full-camera"].filter((l) => count(l) > 0);
  const repeats = plan.layoutRuns.slice(1).filter((r, i) => r.layout === plan.layoutRuns[i]!.layout).map((r) => r.id);
  const long = plan.layoutRuns.filter((r) => flicksToSeconds(r.outEnd - r.outStart) > 8.5).map((r) => `${r.id} ${flicksToSeconds(r.outEnd - r.outStart).toFixed(1)} s`);
  const logged = plan.layoutRuns.flatMap((r) => r.exceptions);
  out.push({
    check: "luxury.layouts",
    category: "layout",
    severity: "soft",
    status: used.length === 3 && !repeats.length && !long.length ? "pass" : logged.length ? "warn" : "warn",
    message: `${count("lt-split")} split / ${count("lt-full-visual")} full visual / ${count("lt-full-camera")} full camera; hook=${plan.layoutRuns[0]!.layout.replace("lt-", "")}, outro=${plan.layoutRuns[plan.layoutRuns.length - 1]!.layout.replace("lt-", "")}${repeats.length ? `; consecutive repeats at ${repeats.join(", ")}` : ""}${long.length ? `; long runs ${long.join(", ")}` : ""}${used.length < 3 ? `; layouts unused: ${["lt-split", "lt-full-visual", "lt-full-camera"].filter((l) => !used.includes(l)).join(", ")} (exceptions: ${logged.join("; ") || "none logged"})` : ""}`,
    evidence: { measurements: { runs: plan.layoutRuns.map((r) => ({ id: r.id, layout: r.layout, s: [flicksToSeconds(r.outStart), flicksToSeconds(r.outEnd)] })) } },
  });

  // L2: source camera footage never moves (one held crop per camera slot).
  const ltCrops = new Set(plan.layoutRuns.filter((r) => r.layout !== "lt-full-visual").flatMap((r) => r.slots.map((s) => s.cropPathId)));
  const moving = plan.cropPaths.filter((c) => ltCrops.has(c.id) && (c.keyframes.length !== 1 || c.interpolation !== "hold"));
  out.push({
    check: "luxury.static-footage",
    category: "framing",
    severity: "hard",
    status: moving.length ? "fail" : "pass",
    message: moving.length ? `camera footage moves in ${moving.map((c) => c.id).join(", ")} (Luxury forbids pans/zooms/punch-ins)` : `${ltCrops.size} camera crop(s), each a single held transform (no pan/zoom/punch-in on footage)`,
  });

  // L3: sharp composed landing frames; blur only while the world camera moves.
  const blurStats: Array<{ run: string; frames: number; blurFrames: number; peak: number; restFramesBlurred: number; firstSigma: number }> = [];
  for (const g of plan.graphics) {
    const c = (g.props as { compiled?: CompiledGraphic }).compiled;
    const r = plan.layoutRuns.find((x) => x.id === g.runId);
    if (!c || !r) continue;
    const frames = Math.round((r.outEnd - r.outStart) / frame);
    const cam = sampleCamera({ frames, fps, init: c.init, moves: c.moves, glide: { ...c.glide, dur: c.durationS }, anchor: c.anchor, shutter: g.motionBlur?.shutter ?? 0.75, maxSigma: 40, blur: g.motionBlur?.enabled ?? true });
    const moving = (t: number) => c.moves.some((m) => t > m.t0 && t < m.t0 + m.dur);
    blurStats.push({ run: g.runId, frames, blurFrames: cam.filter((f) => f.blur.sigma > 0).length, peak: Math.max(0, ...cam.map((f) => f.blur.sigma)), restFramesBlurred: cam.filter((f) => f.blur.sigma > 0 && !moving(f.t)).length, firstSigma: cam[0]!.blur.sigma });
  }
  const badLanding = blurStats.filter((b) => b.firstSigma > 0 || b.restFramesBlurred > 0 || b.peak > 40);
  out.push({
    check: "luxury.landing-sharp",
    category: "graphics",
    severity: "hard",
    status: badLanding.length ? "fail" : "pass",
    message: badLanding.length ? `blur outside motion in ${badLanding.map((b) => b.run).join(", ")}` : `every run lands sharp (σ=0 on frame 0 and at rest); blur on ${blurStats.reduce((a, b) => a + b.blurFrames, 0)} moving frame(s), peak σ ${Math.max(0, ...blurStats.map((b) => b.peak)).toFixed(1)} px ≤ 40`,
    evidence: { measurements: { runs: blurStats } },
  });

  // L4: caption zones per run and semantic yellow highlights.
  if (plan.captions && captions) {
    const misplaced: string[] = [];
    for (const st of captions.states) {
      const b = captions.stateBounds[st.index];
      if (!b) continue;
      if (b.y0 < st.zone.y0 - 24 || b.y1 > st.zone.y1 + 24) misplaced.push(`${st.chunkId} y ${Math.round(b.y0)}–${Math.round(b.y1)} vs zone ${st.zone.y0}–${st.zone.y1}`);
    }
    out.push({
      check: "luxury.caption-zones",
      category: "captions",
      severity: "soft",
      status: misplaced.length ? "warn" : "pass",
      message: misplaced.length ? `${misplaced.length} caption state(s) outside their run's zone: ${misplaced.slice(0, 4).join("; ")}` : `all ${captions.states.length} caption states sit inside their run's zone (split 941–1114, full camera/visual 1267–1536)`,
    });
    const chunks = plan.captions.chunks;
    const hl = chunks.map((c) => c.words.filter((w) => w.emphasis === "highlight"));
    const fnHl = hl.flat().filter((w) => isFunctionWord(w.text));
    const consecutive = chunks.slice(1).filter((_, i) => hl[i]!.length > 0 && hl[i + 1]!.length > 0).map((c) => c.id);
    const style = loadCaptionStyle(plan.captions.styleId);
    const styleOk = (style.emphasis.treatment.color ?? "").toUpperCase() === "#FFFF00" && style.emphasis.treatment.style === "italic" && /instrument serif/i.test(style.emphasis.treatment.family ?? "");
    const firstStart = chunks[0]?.outStart ?? 0;
    out.push({
      check: "luxury.highlights",
      category: "captions",
      severity: "hard",
      status: fnHl.length || consecutive.length || !styleOk || firstStart < frame ? "fail" : "pass",
      message: `${hl.filter((x) => x.length).length} highlighted chunk(s) of ${chunks.length}: ${hl.flat().map((w) => w.text).join(", ") || "none"}${fnHl.length ? `; function words highlighted: ${fnHl.map((w) => w.text).join(", ")}` : ""}${consecutive.length ? `; consecutive highlighted chunks at ${consecutive.join(", ")}` : ""}${styleOk ? "; Instrument Serif italic #FFFF00" : "; highlight treatment is not Instrument Serif italic #FFFF00"}; first caption at frame ${Math.round(firstStart / frame)}`,
    });
  }

  // L5: SFX vocabulary rules (whoosh only on whips, at the midpoint; limits; no sounds on cuts).
  const whips = plan.graphics.flatMap((g) => g.camera.filter((c) => c.kind === "whip" && c.midpointFlicks !== undefined).map((c) => ({ id: `${g.runId}-whip`, midpointS: flicksToSeconds(c.midpointFlicks!) })));
  const sfxEvents = plan.audio.sfx.map((e) => ({ id: e.id, tS: flicksToSeconds(e.t), kind: e.kind, variant: e.variant, ...(e.linkedEventId ? { linkedEventId: e.linkedEventId } : {}) }));
  const cutsS = plan.layoutRuns.slice(1).map((r) => flicksToSeconds(r.outStart));
  const sfxCheck = await py<{ violations: Array<{ id: string; rule: string; detail: string }> }>("synth.validate", { events: sfxEvents, whips, cutsS, runs: plan.layoutRuns.map((r) => ({ id: r.id, startS: flicksToSeconds(r.outStart), endS: flicksToSeconds(r.outEnd) })), maxPerRun: 1, maxTotal: 3 });
  out.push({
    check: "luxury.sfx-rules",
    category: "audio",
    severity: "hard",
    status: sfxCheck.violations.length ? "fail" : "pass",
    message: sfxCheck.violations.length ? sfxCheck.violations.map((v) => `${v.rule}: ${v.detail}`).join("; ") : `${plan.audio.sfx.length} SFX tied to visible graphics events (${[...new Set(plan.audio.sfx.map((e) => e.kind))].join(", ") || "none"}); ${whips.length} whip(s) with whoosh at the midpoint; none on layout cuts${plan.audio.riser?.enabled ? `; riser ends at the hook join ${flicksToSeconds(plan.audio.riser.endFlicks).toFixed(3)} s` : ""}`,
    evidence: { measurements: { violations: sfxCheck.violations, whips } },
  });

  // L6: head matte — stable and frame-aligned with the card footage, or a reported fallback.
  if (luxury) {
    const pieces = [...luxury.pieces.values()].filter((m) => m.qa);
    const failed = pieces.filter((m) => m.qa && !m.qa.ok);
    out.push({
      check: "luxury.matte",
      category: "framing",
      severity: "hard",
      status: pieces.length === 0 ? "not-run" : failed.length ? "warn" : "pass",
      message: pieces.length === 0 ? "no split run with a head break-out" : failed.length ? `${failed.length}/${pieces.length} split piece(s) fell back to a contained card: ${failed.map((m) => m.fallback).join("; ")}` : `${pieces.length} split piece(s): matte frame-to-frame IoU ≥ ${Math.min(...pieces.map((m) => m.qa!.iouMin)).toFixed(3)}, ${pieces.every((m) => m.qa!.alignment?.aligned) ? "frame-aligned with the card footage (same clip, probe-verified)" : "alignment probe inconclusive"}`,
      evidence: { measurements: { pieces: pieces.map((m) => ({ iouMean: m.qa!.iouMean, iouMin: m.qa!.iouMin, unstable: m.qa!.unstableTransitions, alignment: m.qa!.alignment, fallback: m.fallback })) } },
    });
  }

  // L7: white-card world — measured ground colours on a full-visual frame; cover only on frame zero.
  const fv = plan.layoutRuns.find((r) => r.layout === "lt-full-visual") ?? plan.layoutRuns.find((r) => r.layout === "lt-split");
  if (fv) {
    const f = Math.round((fv.outStart + fv.outEnd) / 2 / frame);
    const pts: Array<[number, number]> = [
      [12, 12],
      [W - 13, 12],
      [12, fv.layout === "lt-split" ? 1100 : 1840],
      [W - 13, fv.layout === "lt-split" ? 1100 : 1840],
    ];
    const got = await rgbAt(video, f, pts, W, H);
    const errs = got.map((c, i) => Math.max(...c.map((v, k) => Math.abs(v - groundAt(pts[i]![0], pts[i]![1])[k]!))));
    out.push({
      check: "luxury.ground",
      category: "graphics",
      severity: "soft",
      status: errs.every((e) => e <= 4) ? "pass" : "warn",
      message: `ground at ${pts.length} empty points of frame ${f} (${fv.id}) within ${Math.max(...errs).toFixed(1)}/255 of the radial #FFFFFF→#F3F3F0 token`,
      evidence: { times: [f * frame], measurements: { points: pts, measured: got.map((c) => c.map((v) => Math.round(v))), expected: pts.map(([x, y]) => groundAt(x, y).map((v) => Math.round(v))) } },
    });
  }
  if (plan.cover?.frameZero) {
    const [c0, c1] = await Promise.all([rgbAt(video, 0, [[540, 432]], W, H), rgbAt(video, 1, [[540, 432]], W, H)]);
    const white0 = Math.min(...c0[0]!) > 235;
    const changed = Math.max(...c0[0]!.map((v, k) => Math.abs(v - c1[0]![k]!)));
    out.push({
      check: "luxury.cover-frame",
      category: "export",
      severity: "soft",
      status: white0 ? "pass" : "warn",
      message: `frame 0 carries the cover title box (centre ${c0[0]!.map((v) => Math.round(v)).join(",")}); frame 1 differs by ${changed.toFixed(0)}/255 there — "${plan.cover.title}"`,
      evidence: { times: [0, frame] },
    });
  }

  // L8: honest frame rate.
  const srcFps = [...input.sources.values()].filter((s) => s.probe.video).map((s) => s.probe.video!.fps.num / s.probe.video!.fps.den);
  if (srcFps.length && Math.max(...srcFps) < fps - 0.5) {
    out.push({
      check: "luxury.frame-rate",
      category: "export",
      severity: "info",
      status: "pass",
      message: `delivered at ${fps} fps; camera footage is ${srcFps.map((f) => f.toFixed(2)).join("/")} fps, so footage frames are repeated (no added motion detail); graphics are rendered at a genuine ${fps} fps`,
    });
  }
  return out;
}
