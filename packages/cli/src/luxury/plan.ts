/**
 * Applies the Luxury Tech preset to an edit plan: layout runs (eye-contact gated),
 * static camera geometry, card + aligned head matte, compiled graphics per run,
 * caption zones, cover, and the code-synthesized audio plan.
 */
import {
  FLICKS_PER_SECOND,
  TimeMap,
  flicksPerFrame,
  flicksToSeconds,
  formatTimecode,
  msToFlicks,
  quantizeToFrame,
  quantizeToSample,
  secondsToFlicks,
  type CaptionChunk,
  type CropPath,
  type EditPlan,
  type Flicks,
  type Graphic,
  type LayoutRun,
  type Preset,
  type SoundEvent,
  type SourceAsset,
  type VisualAnalysis,
} from "../../../core/src/index.ts";
import { luxuryCaptionZone, planLuxuryLayout, type LtLine } from "../../../core/src/luxury/layout.ts";
import { autoGraphic, compileGraphic, withCoverReveal, type CompiledGraphic, type GraphicRunSpec, type GraphicsBrief, type RunWord } from "../../../core/src/luxury/graphics.ts";
import { outputGaze } from "./gaze.ts";
import { CARD, FEATHER_PX, fullCameraCrop, presentedFace, splitGeometry, type SplitGeometry } from "./geometry.ts";

export interface LuxuryInput {
  plan: EditPlan;
  preset: Preset;
  camera: SourceAsset;
  visual: VisualAnalysis | null;
  brief: GraphicsBrief;
  title?: string;
}

export interface LuxuryResult {
  plan: EditPlan;
  table: string;
  exceptions: string[];
  warnings: string[];
  geometry: SplitGeometry;
}

interface PlanWord extends RunWord {
  sourceWordId: string;
}

/** A word belongs to the run containing its midpoint (J-cut audio may lead the picture cut). */
function inRun(w: { start: Flicks; end: Flicks }, a: Flicks, b: Flicks): boolean {
  const mid = (w.start + w.end) / 2;
  return mid >= a && mid < b;
}

function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * Lines = take lines (consecutive segments of one line — e.g. split by pause
 * compression — stay together), further split at sentence ends (cuts between words).
 */
function planLines(plan: EditPlan, words: PlanWord[]): LtLine[] {
  const fps = plan.output.fps;
  const sorted = [...plan.segments].sort((a, b) => a.picture.outStart - b.picture.outStart);
  const segs: Array<{ id: string; lineId: string | undefined; wordIds: string[]; start: Flicks; end: Flicks }> = [];
  for (const seg of sorted) {
    const prev = segs[segs.length - 1];
    if (prev && seg.lineId && prev.lineId === seg.lineId) {
      prev.end = seg.picture.outEnd;
      prev.wordIds = [...prev.wordIds, ...seg.wordIds];
    } else segs.push({ id: seg.id, lineId: seg.lineId, wordIds: [...seg.wordIds], start: seg.picture.outStart, end: seg.picture.outEnd });
  }
  const lines: LtLine[] = [];
  segs.forEach((seg, i) => {
    const ids = new Set(seg.wordIds);
    const ws = words.filter((w) => ids.has(w.sourceWordId)).sort((a, b) => a.start - b.start);
    const base = seg.lineId ?? seg.id;
    const start = i === 0 ? 0 : seg.start;
    const end = i === segs.length - 1 ? plan.output.durationFlicks : seg.end;
    const groups: PlanWord[][] = [[]];
    ws.forEach((w, k) => {
      groups[groups.length - 1]!.push(w);
      if (/[.!?]["')\]]?$/.test(w.text) && k < ws.length - 1) groups.push([]);
    });
    const parts = groups.filter((g) => g.length > 0);
    if (parts.length <= 1) {
      lines.push({ id: base, start, end, words: ws });
      return;
    }
    let a = start;
    parts.forEach((g, k) => {
      const next = parts[k + 1];
      const b = next ? quantizeToFrame(Math.round((g[g.length - 1]!.end + next[0]!.start) / 2), fps, "round") : end;
      lines.push({ id: `${base}.${k + 1}`, start: a, end: b, words: g });
      a = b;
    });
  });
  return lines;
}

/** Splits caption chunks that straddle a layout cut so each chunk sits in one zone. */
export function splitChunksAtCuts(chunks: CaptionChunk[], cuts: Flicks[], frame: number): CaptionChunk[] {
  const out: CaptionChunk[] = [];
  for (const c of chunks) {
    const cut = cuts.find((x) => x > c.outStart && x < c.outEnd);
    if (cut === undefined) {
      out.push(c);
      continue;
    }
    const a = c.words.filter((w) => (w.outStart + w.outEnd) / 2 < cut);
    const b = c.words.filter((w) => (w.outStart + w.outEnd) / 2 >= cut);
    if (a.length === 0) {
      out.push({ ...c, outStart: cut });
      continue;
    }
    if (b.length === 0 || cut - c.outStart < frame || c.outEnd - cut < frame) {
      out.push({ ...c, outEnd: Math.max(c.outStart + frame, cut) });
      continue;
    }
    const aIds = new Set(a.map((w) => w.id));
    const hadHighlight = a.some((w) => w.emphasis === "highlight");
    const bWords = hadHighlight ? b.map((w) => (w.emphasis === "highlight" ? { ...w, emphasis: "none" as const } : w)) : b;
    out.push({ ...c, id: `${c.id}a`, outEnd: cut, words: a, lines: c.lines.map((l) => l.filter((id) => aIds.has(id))).filter((l) => l.length) });
    out.push({ ...c, id: `${c.id}b`, outStart: cut, words: bWords, lines: c.lines.map((l) => l.filter((id) => !aIds.has(id))).filter((l) => l.length) });
  }
  return out;
}

/**
 * The director's spec for a run: by planned run id, or by the exact set of line ids
 * it covers (`part` picks among runs sharing those lines, e.g. after an eye-contact split).
 */
function findSpec(brief: GraphicsBrief, runId: string, lineIds: string[], part: number): GraphicRunSpec | null {
  const same = (a: string[]) => a.length === lineIds.length && a.every((l) => lineIds.includes(l));
  return brief.runs.find((r) => r.run === runId) ?? brief.runs.find((r) => r.lines !== undefined && same(r.lines) && (r.part ?? 1) === part) ?? null;
}

function autoTitle(hook: RunWord[]): string {
  const text = hook.map((w) => w.text).join(" ").replace(/[.!?]+$/, "");
  if (text.length <= 44) return text;
  return hook.slice(0, 6).map((w) => w.text).join(" ").replace(/[,.;:!?]+$/, "");
}

function graphicEvents(g: CompiledGraphic, runStart: Flicks): Graphic["events"] {
  const kindOf: Record<string, Graphic["events"][number]["kind"]> = { enter: "land", type: "type", send: "click", response: "response", mark: "reveal", stamp: "reveal", focus: "other", "inner-zoom": "other", click: "click" };
  return g.actions.map((a, i) => ({
    id: `ge${String(i + 1).padStart(3, "0")}`,
    t: runStart + secondsToFlicks(a.t),
    kind: kindOf[a.kind] ?? "other",
    durationFlicks: secondsToFlicks(a.dur),
    target: a.target,
    detail: a.kind,
  }));
}

export function buildLuxury(input: LuxuryInput): LuxuryResult {
  const { plan, preset, camera, visual, brief } = input;
  if (!plan.captions || plan.captions.chunks.length === 0) throw new Error("Luxury Tech needs final word timings (captions) on the plan");
  if (!camera.probe.video) throw new Error("Luxury Tech needs a camera picture source");
  const fps = plan.output.fps;
  const frame = flicksPerFrame(fps);
  const END = plan.output.durationFlicks;
  const map = new TimeMap(plan.timeMap);
  const frameSize = { width: camera.probe.video.displayWidth, height: camera.probe.video.displayHeight };
  const exceptions: string[] = [];
  const warnings: string[] = [];

  // 1. Words, lines, eye-contact evidence, layout runs.
  const words: PlanWord[] = plan.captions.chunks.flatMap((c) => c.words.map((w) => ({ id: w.id, text: w.text, start: w.outStart, end: w.outEnd, sourceWordId: w.sourceWordId })));
  const lines = planLines(plan, words).map((l) => (brief.intents[l.id] ? { ...l, intent: brief.intents[l.id] } : l));
  const gaze = outputGaze(visual, map, camera.id);
  const layout = planLuxuryLayout({ lines, end: END, fps, gaze: gaze.evidence, maxRunFlicks: secondsToFlicks(8), minRunFlicks: secondsToFlicks(1.2), atLensMin: 0.7, hasCta: Boolean(brief.cta) });
  exceptions.push(...layout.exceptions);

  // 2. Geometry: one static full-camera crop; one shared card/head transform.
  const face = presentedFace(visual?.faceTracks ?? [], map, camera.id);
  const fullBox = fullCameraCrop(frameSize, face);
  const geo = splitGeometry(frameSize, face);
  for (const n of geo.notes) warnings.push(`split geometry: ${n}`);
  const cropPaths: CropPath[] = [
    { id: "lt-fullcam", sourceId: camera.id, slot: "main", aspect: fullBox.w / fullBox.h, keyframes: [{ t: 0, box: fullBox, hold: true }], interpolation: "hold", trackIds: [], reason: "Luxury full camera: one stable cover-fit crop decided at setup (no pan/zoom/punch-in)", confidence: face ? 0.9 : 0.5, manual: false },
    { id: "lt-card", sourceId: camera.id, slot: "card", aspect: geo.card.srcBox.w / geo.card.srcBox.h, keyframes: [{ t: 0, box: geo.card.srcBox, hold: true }], interpolation: "hold", trackIds: [], reason: `split camera card: source × ${geo.s.toFixed(4)} at (${Math.round(geo.X)}, ${Math.round(geo.Y)})`, confidence: face ? 0.9 : 0.5, manual: false },
  ];
  if (geo.head) cropPaths.push({ id: "lt-head", sourceId: camera.id, slot: "head", aspect: geo.head.srcBox.w / geo.head.srcBox.h, keyframes: [{ t: 0, box: geo.head.srcBox, hold: true }], interpolation: "hold", trackIds: [], reason: "head matte band: same frame and transform as the card", confidence: 0.85, manual: false });

  // 3. Runs + graphics.
  const graphics: Graphic[] = [];
  const runs: LayoutRun[] = [];
  const compiledByRun = new Map<string, CompiledGraphic>();
  const hookRun = layout.runs.find((r) => r.role === "hook") ?? layout.runs[0]!;
  const title = input.title ?? brief.title ?? autoTitle(words.filter((w) => inRun(w, hookRun.start, hookRun.end)));
  layout.runs.forEach((r, i) => {
    const id = `run${String(i + 1).padStart(3, "0")}`;
    const runWords = words.filter((w) => inRun(w, r.start, r.end));
    const isGraphics = r.layout !== "lt-full-camera";
    let spec: GraphicRunSpec | null = null;
    let auto = false;
    let compiled: CompiledGraphic | null = null;
    if (isGraphics) {
      const part = 1 + layout.runs.slice(0, i).filter((x) => x.lineIds.join("+") === r.lineIds.join("+") && x.layout !== "lt-full-camera").length;
      spec = findSpec(brief, id, r.lineIds, part);
      if (!spec) {
        auto = true;
        const keywords = plan.captions!.chunks.flatMap((c) => c.words).filter((w) => w.emphasis !== "none" && inRun({ start: w.outStart, end: w.outEnd }, r.start, r.end)).map((w) => w.display.replace(/[.,!?;:]+$/, ""));
        spec = autoGraphic(runWords, r.layout, keywords);
        warnings.push(`${id}: no director graphic for lines ${r.lineIds.join("+")} — auto card "${spec.subject}"`);
      }
      compiled = compileGraphic(spec, { layout: r.layout, runStart: r.start, runEnd: r.end, words: runWords, fps: fps.num / fps.den });
      if (i === 0) compiled = withCoverReveal(compiled, fps.num / fps.den);
      for (const w of compiled.warnings) warnings.push(`${id}: ${w}`);
      compiledByRun.set(id, compiled);
      graphics.push({
        id: `g-${id}`,
        runId: id,
        template: "lt-world",
        subject: compiled.subject,
        props: { compiled, spec, auto, cover: i === 0 },
        events: graphicEvents(compiled, r.start),
        camera: compiled.moves.map((m) => ({ t: r.start + secondsToFlicks(m.t0), kind: m.kind, durationFlicks: secondsToFlicks(m.dur), ease: m.ease ?? (m.kind === "whip" ? "power3.in/power3.out" : "power2.inOut"), scale: m.to.s, ...(m.kind === "whip" ? { midpointFlicks: r.start + secondsToFlicks(m.t0 + m.dur * (m.departFrac ?? 0.45 / 1.05)) } : {}) })),
        sources: spec.sources,
        motionBlur: { enabled: preset.graphics.motionBlur.enabled, samplesPerFrame: 1, shutter: preset.graphics.motionBlur.shutter },
      });
    }
    const zone = luxuryCaptionZone(preset.captions.zones, r.layout, { outroWithCta: r.role === "outro" && Boolean(brief.cta), lowContent: spec?.lowContent ?? false });
    const slots: LayoutRun["slots"] =
      r.layout === "lt-full-camera"
        ? [{ slot: "main", cropPathId: "lt-fullcam", region: { x: 0, y: 0, w: 1080, h: 1920 }, radius: 0, blurPx: 0, dim: 0 }]
        : r.layout === "lt-split"
          ? [
              { slot: "card", cropPathId: "lt-card", region: geo.card.region, radius: 0, blurPx: 0, dim: 0, mask: { x: CARD.x, y: CARD.y, w: CARD.w, h: CARD.h, radius: CARD.radius } },
              ...(geo.head ? [{ slot: "head", cropPathId: "lt-head", region: geo.head.region, radius: 0, blurPx: 0, dim: 0, matte: { alignedWith: "card", featherY: CARD.y, featherPx: FEATHER_PX, engine: "hyperframes remove-background (u2net_human_seg, local CPU)" } }] : []),
            ]
          : [];
    runs.push({
      id,
      outStart: r.start,
      outEnd: r.end,
      layout: r.layout,
      slots,
      ...(isGraphics ? { graphicId: `g-${id}` } : {}),
      captionZone: zone,
      reason: `${r.role}: ${r.reason}`,
      eventIds: [],
      exceptions: [...r.exceptions, ...(r.layout === "lt-split" && geo.contained ? ["contained camera card (no head break-out): " + geo.notes.join("; ")] : [])],
    });
  });

  // 4. Captions: one zone per chunk — split chunks at layout cuts.
  const cuts = runs.slice(1).map((r) => r.outStart);
  const chunks = splitChunksAtCuts(plan.captions.chunks, cuts, frame);

  // 5. Audio: synthesized bed, SFX from visible graphics events, intro riser into the first point.
  const seed = fnv(`${plan.projectId}/${plan.clipId}`) % 100_000;
  const rel = preset.audio.sfx.relPeakDb;
  const sfx: SoundEvent[] = [];
  let whooshVariant = -1;
  let whooshes = 0;
  for (const run of runs) {
    const g = compiledByRun.get(run.id);
    if (!g) continue;
    let runWhoosh = 0;
    let tickN = 0;
    for (const s of g.sounds) {
      if (s.kind === "whoosh") {
        if (runWhoosh >= preset.audio.sfx.maxWhooshPerRun || whooshes >= preset.audio.sfx.maxWhooshTotal) {
          exceptions.push(`${run.id}: whip at ${(flicksToSeconds(run.outStart) + s.t).toFixed(2)} s left silent (whoosh limit ${preset.audio.sfx.maxWhooshPerRun}/run, ${preset.audio.sfx.maxWhooshTotal}/short)`);
          continue;
        }
        runWhoosh++;
        whooshes++;
        whooshVariant = (whooshVariant + 1) % 4;
      }
      const t = quantizeToSample(run.outStart + secondsToFlicks(s.t), plan.output.sampleRate);
      if (t >= END) continue;
      sfx.push({
        id: `sfx${String(sfx.length + 1).padStart(3, "0")}`,
        t,
        kind: s.kind,
        variant: s.kind === "whoosh" ? whooshVariant : s.kind === "tick" ? tickN++ % 4 : 0,
        relPeakDb: rel[s.kind] ?? -12,
        linkedEventId: s.kind === "whoosh" ? `${run.id}-whip` : s.linked,
        runId: run.id,
        reason: s.reason,
      });
    }
  }
  const hookEnd = runs[0]!.outEnd;
  const hookSec = flicksToSeconds(hookEnd);
  const riserCfg = preset.audio.riser;
  let riser: EditPlan["audio"]["riser"] = null;
  if (riserCfg?.enabled) {
    const dur = Math.min(riserCfg.maxMs / 1000, Math.max(riserCfg.minMs / 1000, hookSec - 0.4));
    if (hookSec >= riserCfg.minMs / 1000 + 0.2 && runs.length > 1) riser = { enabled: true, endFlicks: hookEnd, durationFlicks: secondsToFlicks(dur), relPeakDb: riserCfg.relPeakDb };
    else exceptions.push(`intro riser skipped: hook run is ${hookSec.toFixed(2)} s (needs ≥ ${(riserCfg.minMs / 1000 + 0.2).toFixed(1)} s and a following point)`);
  }
  const durS = flicksToSeconds(END);
  const music: EditPlan["audio"]["music"] = {
    mode: "synth",
    seed,
    bpm: (preset.audio.music.bpmRange?.[0] ?? 100) + (seed % ((preset.audio.music.bpmRange?.[1] ?? 120) - (preset.audio.music.bpmRange?.[0] ?? 100) + 1)),
    key: ["C", "D", "F", "G", "A"][seed % 5]!,
    targetLufs: preset.audio.music.targetLufs,
    fadeOutFlicks: msToFlicks(Math.min(preset.audio.music.fadeOutMs, Math.max(200, durS * 100))),
    declickFlicks: msToFlicks(preset.audio.music.declickMs),
    ducking: false,
    gainDb: 0,
    params: {},
  };

  const next: EditPlan = {
    ...plan,
    layoutRuns: runs,
    cropPaths,
    captions: { ...plan.captions, chunks, notes: [...plan.captions.notes, "chunks split at layout cuts so each sits in its run's caption zone"] },
    graphics,
    audio: { ...plan.audio, music, sfx, riser },
    cover: { title, titleSource: input.title ? "user" : brief.title ? "user" : "hook", frameZero: true, style: preset.cover.style, exportImage: true },
    cta: null,
    decisions: [
      ...plan.decisions.filter((d) => !d.key.startsWith("luxury.")),
      { key: "luxury.gaze", value: gaze.note, layer: "default", reason: "camera shown only while head orientation says the presenter looks at the lens" },
      { key: "luxury.split-transform", value: { s: geo.s, X: geo.X, Y: geo.Y, headTop: geo.headTopCanvas }, layer: "preset", reason: "one transform shared by card footage and head matte" },
      { key: "luxury.music", value: { bpm: music.bpm, key: music.key, seed }, layer: "preset", reason: "original synthesized bed, one flat gain to −24 LUFS, no ducking" },
    ],
    fallbacks: [...plan.fallbacks.filter((f) => !f.capability.startsWith("luxury")), ...(geo.contained && runs.some((r) => r.layout === "lt-split") ? [{ capability: "luxury head break-out", reason: geo.notes.join("; "), fallback: "contained camera card" }] : [])],
  };
  if (brief.cta) {
    const kw = brief.cta.keyword.toLowerCase();
    const spoken = words.find((w) => w.text.toLowerCase().replace(/[^a-z0-9]/g, "") === kw.replace(/[^a-z0-9]/g, ""));
    if (brief.cta.requestedBy === "speech" && !spoken) throw new Error(`CTA keyword "${brief.cta.keyword}" is not in the speech; use requestedBy "brief" or "user" only when the brief/user asked for it`);
    const outro = runs[runs.length - 1]!;
    if (outro.layout !== "lt-full-camera") exceptions.push(`CTA shown over a ${outro.layout.replace("lt-", "")} outro (full camera unavailable)`);
    // Schedule: box at the outro start, typing from the spoken keyword (or shortly after), Post after typing.
    const show = outro.outStart;
    const typeAt = Math.max(show + secondsToFlicks(0.35), spoken ? spoken.start : show + secondsToFlicks(0.5));
    const typeDur = secondsToFlicks(Math.max(0.5, brief.cta.keyword.length / 12));
    const postAt = Math.min(END - secondsToFlicks(0.45), typeAt + typeDur + secondsToFlicks(0.35));
    if (postAt <= typeAt + typeDur) exceptions.push("CTA outro too short for typing + Post press; Post press compressed");
    next.cta = { keyword: brief.cta.keyword, requestedBy: brief.cta.requestedBy, spoken: spoken ? { start: spoken.start, end: spoken.end } : null, composition: "lt-cta", box: { x: 43, y: 1344, w: 994, h: 276 }, showFlicks: show, typeAtFlicks: typeAt, postAtFlicks: postAt };
    const chars = brief.cta.keyword.length;
    for (let k = 0; k < chars; k += 2) next.audio.sfx.push({ id: `sfx${String(next.audio.sfx.length + 1).padStart(3, "0")}`, t: quantizeToSample(typeAt + Math.round((typeDur * k) / chars), plan.output.sampleRate), kind: "tick", variant: k % 4, relPeakDb: rel.tick ?? -16, linkedEventId: "cta-type", runId: outro.id, reason: "CTA keyword typing" });
    next.audio.sfx.push({ id: `sfx${String(next.audio.sfx.length + 1).padStart(3, "0")}`, t: quantizeToSample(postAt, plan.output.sampleRate), kind: "click", variant: 0, relPeakDb: rel.click ?? -10, linkedEventId: "cta-post", runId: outro.id, reason: "CTA Post press" });
  }
  return { plan: next, table: layoutTable(next, lines), exceptions, warnings, geometry: geo };
}

export function layoutTable(plan: EditPlan, lines: LtLine[]): string {
  const words = plan.captions?.chunks.flatMap((c) => c.words) ?? [];
  const rows = plan.layoutRuns.map((r) => {
    const g = plan.graphics.find((x) => x.id === r.graphicId);
    const ws = words.filter((w) => inRun({ start: w.outStart, end: w.outEnd }, r.outStart, r.outEnd)).map((w) => w.text).join(" ");
    const segs = plan.segments.filter((s) => s.picture.outStart < r.outEnd && s.picture.outEnd > r.outStart);
    const src = segs.map((s) => `${s.lineId ?? s.id}${s.takeId ? `/${s.takeId}` : ""} @${formatTimecode(s.picture.srcStart + Math.max(0, r.outStart - s.picture.outStart))}`).join(", ");
    const events = [...(g?.camera ?? []).map((c) => `${c.kind}@${flicksToSeconds(c.t).toFixed(2)}`), ...plan.audio.sfx.filter((s) => s.runId === r.id && s.kind !== "tick").map((s) => `${s.kind}@${flicksToSeconds(s.t).toFixed(2)}`)].join(" ");
    const auto = g && (g.props as { auto?: boolean }).auto ? " (auto)" : "";
    return `| ${r.id} | ${flicksToSeconds(r.outStart).toFixed(3)}–${flicksToSeconds(r.outEnd).toFixed(3)} | ${r.layout.replace("lt-", "")} | ${src} | ${ws.replace(/\|/g, "/")} | ${g ? g.subject + auto : "camera"} | ${r.captionZone.y0}–${r.captionZone.y1} | ${events || "—"} |`;
  });
  const exc = plan.layoutRuns.flatMap((r) => r.exceptions.map((e) => `- ${r.id}: ${e}`));
  return [
    `# Layout runs — ${plan.clipId} v${plan.version}`,
    "",
    `END ${flicksToSeconds(plan.output.durationFlicks).toFixed(3)} s · ${plan.output.frameCount} frames @ ${plan.output.fps.num / plan.output.fps.den} fps · lines: ${lines.map((l) => l.id).join(", ")}`,
    "",
    "| Run | Time (s) | Layout | Source / take | Words | Graphic subject | Caption zone | Planned events |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    ...(exc.length ? ["## Exceptions", ...exc] : []),
  ].join("\n");
}

export const LUXURY_FPS = { num: 60, den: 1 } as const;
export const LUXURY_FRAME = FLICKS_PER_SECOND / 60;
