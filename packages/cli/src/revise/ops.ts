import { z } from "zod";
import {
  EditPlanSchema,
  TimeMap,
  applyEmphasis,
  buildTimeMapPieces,
  computeExtent,
  flicksPerFrame,
  formatTimecode,
  groupCaptions,
  makeMeasurer,
  msToFlicks,
  parseTimecode,
  quantizeToFrame,
  quantizeToSample,
  retimeWords,
  type CaptionStyle,
  type CropPath,
  type EditPlan,
  type Flicks,
  type LayoutRun,
  type MetricsTable,
  type Transcript,
  type VisualAnalysis,
} from "../../../core/src/index.ts";
import { cropAt, groupCrop } from "../../../core/src/framing/crop.ts";
import { wordSpacingPx } from "../../../adapters/src/render/captions.ts";

/** Typed revision operations. Claude maps the user's words to these; the CLI applies them. */
export const ReviseOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("extend-end"), ms: z.number().positive() }),
  z.object({ op: z.literal("trim-end"), ms: z.number().positive() }),
  z.object({ op: z.literal("extend-start"), ms: z.number().positive() }),
  z.object({ op: z.literal("trim-start"), ms: z.number().positive() }),
  z.object({ op: z.literal("keep-both-visible"), from: z.string(), to: z.string(), timebase: z.enum(["output", "source"]).default("output") }),
  z.object({ op: z.literal("switch-speaker"), at: z.string(), timebase: z.enum(["output", "source"]).default("output"), trackId: z.string().optional() }),
  z.object({ op: z.literal("reduce-motion") }),
  z.object({ op: z.literal("caption-style"), styleId: z.string() }),
  z.object({ op: z.literal("caption-emphasis"), keywords: z.array(z.string()).default([]), onlyKeywords: z.boolean().default(false), mode: z.enum(["none", "semantic", "cadence", "current-word"]).optional() }),
  z.object({ op: z.literal("music-gain"), db: z.number() }),
  z.object({ op: z.literal("caption-zone"), from: z.string(), to: z.string(), y0: z.number(), y1: z.number(), reason: z.string() }),
  /** Fix a mis-heard/misspelled word in the captions (timing kept, correction recorded). */
  z.object({ op: z.literal("caption-correct"), from: z.string(), to: z.string(), at: z.string().optional(), reason: z.string().default("transcription correction") }),
  /** Voice cleanup settings (conservative by default); audio stage only. */
  z.object({ op: z.literal("voice-chain"), denoise: z.enum(["off", "light", "medium"]).optional(), deess: z.boolean().optional(), compress: z.boolean().optional(), highpassHz: z.number().min(0).max(200).nullable().optional() }),
]);
export type ReviseOp = z.infer<typeof ReviseOpSchema>;

export interface ReviseContext {
  transcript: Transcript;
  visual: VisualAnalysis | null;
  frame: { width: number; height: number; durationFlicks: Flicks };
  styleFor: (id: string) => CaptionStyle;
  metrics: MetricsTable;
  zoneFor: (layout: string) => { y0: number; y1: number };
}

export interface ReviseResult {
  plan: EditPlan;
  changes: EditPlan["changes"];
  /** Stages whose inputs changed (everything else is reused from cache). */
  invalidated: string[];
}

function rebuildTimeline(plan: EditPlan): EditPlan {
  const extent = computeExtent(plan.segments, plan.output.fps);
  plan.segments[plan.segments.length - 1]!.picture.outEnd = extent.end;
  const runs = plan.layoutRuns.filter((r) => r.outStart < extent.end);
  runs[runs.length - 1]!.outEnd = extent.end;
  return {
    ...plan,
    timeMap: buildTimeMapPieces(plan.segments),
    layoutRuns: runs,
    output: { ...plan.output, durationFlicks: extent.end, voiceEndFlicks: extent.voiceEnd, frameCount: extent.frameCount },
  };
}

/** Re-derives captions from the (changed) time map — never shifts old caption times. */
export function recaption(plan: EditPlan, ctx: ReviseContext, styleId?: string, emphasis?: { keywords: string[]; onlyKeywords: boolean; mode?: CaptionStyle["emphasis"]["mode"] }): EditPlan {
  if (!plan.captions) return plan;
  const style = ctx.styleFor(styleId ?? plan.captions.styleId);
  const voice = plan.audio.voice.sourceId;
  const words = retimeWords(ctx.transcript.words, new TimeMap(buildTimeMapPieces(plan.segments)), voice).words;
  const measure = makeMeasurer(ctx.metrics, {
    family: style.base.family,
    weight: style.base.weight,
    style: style.base.style,
    sizePx: style.base.sizePx,
    letterSpacingEm: style.base.letterSpacingEm,
    strokePx: style.base.stroke?.widthPx ?? 0,
    upper: style.base.case === "upper",
    wordSpacingPx: wordSpacingPx(style),
  });
  const prevOverrides = plan.captions.overrides as { keywords?: string[]; onlyKeywords?: boolean; emphasisMode?: string };
  const keywords = emphasis?.keywords ?? prevOverrides.keywords ?? [];
  const onlyKeywords = emphasis?.onlyKeywords ?? prevOverrides.onlyKeywords ?? false;
  const mode = (emphasis?.mode ?? prevOverrides.emphasisMode ?? style.emphasis.mode) as CaptionStyle["emphasis"]["mode"];
  const grouped = groupCaptions(words, style.grouping, { fps: plan.output.fps, minStart: plan.captions.minStartFlicks, end: plan.output.durationFlicks, measure, maxWidthPx: style.placement.maxWidthPx, caseMode: style.base.case, keepTogether: keywords });
  const emph = applyEmphasis(grouped.chunks, { mode, maxWordsPerChunk: style.emphasis.maxWordsPerChunk, ...(style.emphasis.cadence ? { cadence: style.emphasis.cadence } : {}), keywords, onlyKeywords });
  return {
    ...plan,
    captions: {
      ...plan.captions,
      styleId: style.id,
      styleVersion: style.version,
      chunks: emph.chunks,
      overrides: { ...plan.captions.overrides, keywords, onlyKeywords, emphasisMode: mode },
    },
  };
}

function resolveTime(plan: EditPlan, text: string, timebase: "output" | "source"): Flicks {
  const t = parseTimecode(text);
  if (timebase === "output") return t;
  const outs = new TimeMap(plan.timeMap).srcToOut("video", plan.sources[0]!.sourceId, t);
  if (outs.length === 0) throw new Error(`source time ${text} is not part of this edit`);
  return outs[0]!;
}

/** Splits layout runs so that [a, b) is covered by its own run(s); returns the affected runs. */
function isolateRange(plan: EditPlan, a: Flicks, b: Flicks): LayoutRun[] {
  const out: LayoutRun[] = [];
  let n = 0;
  for (const r of plan.layoutRuns) {
    const cuts = [r.outStart, Math.max(r.outStart, Math.min(a, r.outEnd)), Math.max(r.outStart, Math.min(b, r.outEnd)), r.outEnd];
    const uniq = [...new Set(cuts)].sort((x, y) => x - y);
    for (let i = 0; i < uniq.length - 1; i++) {
      if (uniq[i + 1]! <= uniq[i]!) continue;
      out.push({ ...r, id: `run${String(++n).padStart(3, "0")}`, outStart: uniq[i]!, outEnd: uniq[i + 1]! });
    }
  }
  plan.layoutRuns = out;
  return out.filter((r) => r.outStart >= a && r.outEnd <= b);
}

function facesAt(plan: EditPlan, ctx: ReviseContext, a: Flicks, b: Flicks) {
  const map = new TimeMap(plan.timeMap);
  const src = plan.sources[0]!.sourceId;
  return (ctx.visual?.faceTracks ?? [])
    .map((t) => ({ t, xs: t.samples.filter((s) => map.srcToOut("video", src, s.t).some((o) => o >= a && o < b)) }))
    .filter((v) => v.xs.length >= 2)
    .map((v) => {
      const mid = v.xs[Math.floor(v.xs.length / 2)]!;
      const eye = mid.landmarks ? (mid.landmarks[1]! + mid.landmarks[3]!) / 2 : mid.box.y + mid.box.h * 0.4;
      return { id: v.t.id, box: mid.box, eye, n: v.xs.length };
    });
}

/** Merges adjacent runs with the same layout and identical static crops; drops unused crops. */
export function mergeRuns(plan: EditPlan): EditPlan {
  const runs: LayoutRun[] = [];
  const boxOf = (id: string) => {
    const c = plan.cropPaths.find((x) => x.id === id);
    return c && c.interpolation === "hold" ? JSON.stringify(c.keyframes[0]!.box) : `moving:${id}`;
  };
  for (const r of plan.layoutRuns) {
    const prev = runs[runs.length - 1];
    if (prev && prev.outEnd === r.outStart && prev.layout === r.layout && prev.slots.length === r.slots.length && prev.slots.every((s, k) => boxOf(s.cropPathId) === boxOf(r.slots[k]!.cropPathId) && s.blurPx === r.slots[k]!.blurPx)) {
      prev.outEnd = r.outEnd;
      if (r.reason.startsWith("revision") && !prev.reason.startsWith("revision")) prev.reason = r.reason;
    } else runs.push({ ...r });
  }
  const used = new Set(runs.flatMap((r) => r.slots.map((s) => s.cropPathId)));
  return { ...plan, layoutRuns: runs.map((r, i) => ({ ...r, id: `run${String(i + 1).padStart(3, "0")}` })), cropPaths: plan.cropPaths.filter((c) => used.has(c.id)) };
}

export function applyOps(base: EditPlan, ops: ReviseOp[], ctx: ReviseContext, reason: string): ReviseResult {
  let plan: EditPlan = structuredClone(base);
  const changes: EditPlan["changes"] = [];
  const invalidated = new Set<string>();
  const fps = plan.output.fps;
  const frame = flicksPerFrame(fps);
  const sr = plan.output.sampleRate;
  const W = plan.output.width;
  const H = plan.output.height;
  let cropN = Math.max(0, ...plan.cropPaths.map((c) => Number(c.id.replace(/\D/g, "")) || 0));
  const newCrop = (box: CropPath["keyframes"][number]["box"], aspect: number, why: string, tracks: string[], t: Flicks): string => {
    const id = `crop${String(++cropN).padStart(3, "0")}`;
    plan.cropPaths.push({ id, sourceId: plan.sources[0]!.sourceId, slot: "main", aspect, keyframes: [{ t, box, hold: true }], interpolation: "hold", trackIds: tracks, reason: why, confidence: 1, manual: true });
    return id;
  };

  for (const op of ops) {
    switch (op.op) {
      case "extend-end":
      case "trim-end": {
        const delta = quantizeToFrame(msToFlicks(op.ms), fps, "round") * (op.op === "extend-end" ? 1 : -1);
        const seg = plan.segments[plan.segments.length - 1]!;
        const srcEnd = seg.picture.srcStart + (seg.picture.outEnd - seg.picture.outStart) + delta;
        if (srcEnd > ctx.frame.durationFlicks) throw new Error("cannot extend past the end of the source");
        if (seg.picture.outEnd + delta <= seg.picture.outStart + frame) throw new Error("trim would remove the whole final segment");
        seg.picture.outEnd += delta;
        for (const a of seg.audio) a.outEnd = quantizeToSample(a.outEnd + delta, sr);
        plan = rebuildTimeline(plan);
        changes.push({ path: "segments[-1].end", op: op.op, reason: `${reason} (${op.op === "extend-end" ? "+" : "−"}${op.ms} ms at the end)` });
        ["captions", "audio", "video"].forEach((s) => invalidated.add(s));
        break;
      }
      case "extend-start":
      case "trim-start": {
        const delta = quantizeToFrame(msToFlicks(op.ms), fps, "round") * (op.op === "extend-start" ? 1 : -1);
        const seg = plan.segments[0]!;
        if (seg.picture.srcStart - delta < 0) throw new Error("cannot extend before the start of the source");
        seg.picture.srcStart -= delta;
        for (const s of plan.segments) {
          if (s !== seg) {
            s.picture.outStart += delta;
            for (const a of s.audio) a.outStart = quantizeToSample(a.outStart + delta, sr);
          }
          s.picture.outEnd += delta;
          for (const a of s.audio) a.outEnd = quantizeToSample(a.outEnd + delta, sr);
        }
        for (const a of seg.audio) a.srcStart -= delta;
        for (const r of plan.layoutRuns) {
          if (r.outStart > 0) r.outStart += delta;
          r.outEnd += delta;
        }
        for (const c of plan.cropPaths) for (const k of c.keyframes) if (k.t > 0) k.t += delta;
        // Every event placed on the output timeline moves with the content.
        for (const e of plan.audio.sfx) e.t += delta;
        for (const g of plan.graphics) {
          for (const e of g.events) e.t += delta;
          for (const m of g.camera) m.t += delta;
        }
        for (const t of plan.titleOverlays) if (t.outStart > 0) t.outStart += delta;
        plan = rebuildTimeline(plan);
        changes.push({ path: "segments[0].start", op: op.op, reason: `${reason} (${op.ms} ms at the start)` });
        ["captions", "audio", "video"].forEach((s) => invalidated.add(s));
        break;
      }
      case "keep-both-visible": {
        const a = quantizeToFrame(resolveTime(plan, op.from, op.timebase), fps, "floor");
        const b = quantizeToFrame(resolveTime(plan, op.to, op.timebase), fps, "ceil");
        const faces = facesAt(plan, ctx, a, b);
        if (faces.length < 2) throw new Error(`fewer than two faces are visible between ${formatTimecode(a)} and ${formatTimecode(b)}`);
        const box = groupCrop(faces.map((f) => f.box), ctx.frame, { aspect: W / H, headroomFrac: 0.1, eyeLineFrac: 0.38 });
        // Continuity: reuse a neighbouring two-shot crop when it already contains everyone.
        const contains = (c: CropPath) => c.interpolation === "hold" && faces.every((f) => f.box.x >= c.keyframes[0]!.box.x && f.box.x + f.box.w <= c.keyframes[0]!.box.x + c.keyframes[0]!.box.w);
        const neighbour = plan.layoutRuns
          .filter((r) => ((r.outStart < a && r.outEnd >= a) || (r.outStart <= b && r.outEnd > b)) && r.layout === "full-crop" && !(r.outStart >= a && r.outEnd <= b))
          .map((r) => plan.cropPaths.find((c) => c.id === r.slots[0]?.cropPathId))
          .find((c): c is CropPath => Boolean(c) && contains(c!));
        const affected = isolateRange(plan, a, b);
        for (const r of affected) {
          if (box || neighbour) {
            r.layout = "full-crop";
            const cropId = neighbour ? neighbour.id : newCrop(box!, W / H, `revision: two-shot keeps ${faces.map((f) => f.id).join(" + ")} visible`, faces.map((f) => f.id), r.outStart);
            r.slots = [{ slot: "main", cropPathId: cropId, region: { x: 0, y: 0, w: W, h: H }, radius: 0, blurPx: 0, dim: 0 }];
          } else {
            const ordered = [...faces].sort((x, y) => x.box.x - y.box.x).slice(0, 2);
            r.layout = "dual-stack";
            r.slots = ordered.map((f, k) => ({ slot: k ? "bottom" : "top", cropPathId: newCrop(cropAt(f.box.x + f.box.w / 2, f.eye, ctx.frame, { aspect: W / (H / 2), headroomFrac: 0.1, eyeLineFrac: 0.42 }), W / (H / 2), `revision: stacked ${f.id}`, [f.id], r.outStart), region: { x: 0, y: k ? H / 2 : 0, w: W, h: H / 2 }, radius: 0, blurPx: 0, dim: 0 }));
          }
          r.captionZone = ctx.zoneFor(r.layout);
          r.reason = `revision: keep both people visible (${reason})`;
        }
        changes.push({ path: `layoutRuns[${formatTimecode(a)}–${formatTimecode(b)}]`, op: "keep-both-visible", reason });
        invalidated.add("video");
        break;
      }
      case "switch-speaker": {
        const t = resolveTime(plan, op.at, op.timebase);
        const run = plan.layoutRuns.find((r) => t >= r.outStart && t < r.outEnd);
        if (!run) throw new Error(`no layout run at ${op.at}`);
        const faces = facesAt(plan, ctx, run.outStart, run.outEnd);
        const current = plan.cropPaths.find((c) => c.id === run.slots[0]?.cropPathId)?.trackIds ?? [];
        const target = op.trackId ? faces.find((f) => f.id === op.trackId) : faces.find((f) => !current.includes(f.id)) ?? faces[0];
        if (!target) throw new Error("no other visible person to switch to in that run");
        run.layout = "full-crop";
        run.slots = [{ slot: "main", cropPathId: newCrop(cropAt(target.box.x + target.box.w / 2, target.eye, ctx.frame, { aspect: W / H, headroomFrac: 0.1, eyeLineFrac: 0.38 }), W / H, `revision: switched to ${target.id}`, [target.id], run.outStart), region: { x: 0, y: 0, w: W, h: H }, radius: 0, blurPx: 0, dim: 0 }];
        run.reason = `revision: switch to ${target.id} (${reason})`;
        changes.push({ path: `layoutRuns[${run.id}]`, op: "switch-speaker", reason: `${reason} → ${target.id}` });
        invalidated.add("video");
        break;
      }
      case "reduce-motion": {
        for (const c of plan.cropPaths) {
          const k0 = c.keyframes[0]!;
          if (c.keyframes.length > 1) {
            c.keyframes = [k0];
            c.interpolation = "hold";
            c.reason = `${c.reason}; motion removed by revision`;
          }
        }
        // Undo punch-ins: runs whose crop is smaller than the widest crop of the same track get the full-size crop.
        const widest = new Map<string, number>();
        for (const c of plan.cropPaths) for (const t of c.trackIds) widest.set(t, Math.max(widest.get(t) ?? 0, c.keyframes[0]!.box.w));
        for (const c of plan.cropPaths) {
          const box = c.keyframes[0]!.box;
          const w = Math.max(...c.trackIds.map((t) => widest.get(t) ?? box.w), box.w);
          if (w > box.w + 0.5) {
            const h = w / c.aspect;
            const cx = box.x + box.w / 2;
            const cy = box.y + box.h / 2;
            c.keyframes = [{ ...c.keyframes[0]!, box: { x: Math.min(Math.max(cx - w / 2, 0), ctx.frame.width - w), y: Math.min(Math.max(cy - h / 2, 0), ctx.frame.height - h), w, h } }];
            c.reason = `${c.reason}; punch-in removed by revision`;
          }
        }
        changes.push({ path: "cropPaths", op: "reduce-motion", reason });
        invalidated.add("video");
        break;
      }
      case "caption-style": {
        plan = recaption(plan, ctx, op.styleId);
        changes.push({ path: "captions.styleId", op: "caption-style", reason: `${reason} → ${op.styleId}` });
        invalidated.add("captions");
        invalidated.add("video");
        break;
      }
      case "caption-emphasis": {
        plan = recaption(plan, ctx, undefined, { keywords: op.keywords, onlyKeywords: op.onlyKeywords, ...(op.mode ? { mode: op.mode } : {}) });
        changes.push({ path: "captions.emphasis", op: "caption-emphasis", reason: `${reason} (keywords: ${op.keywords.join(", ") || "none"}${op.onlyKeywords ? ", keywords only" : ""})` });
        invalidated.add("captions");
        invalidated.add("video");
        break;
      }
      case "caption-correct": {
        if (!plan.captions) throw new Error("this edit has no captions");
        const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
        const want = norm(op.from);
        const near = op.at !== undefined ? parseTimecode(op.at) : null;
        let hits = 0;
        plan.captions.chunks = plan.captions.chunks.map((c) => ({
          ...c,
          words: c.words.map((w) => {
            if (norm(w.text) !== want && norm(w.display) !== want) return w;
            if (near !== null && Math.abs(w.outStart - near) > msToFlicks(1500)) return w;
            hits++;
            const trail = /[.,!?;:]+$/.exec(w.display)?.[0] ?? "";
            return { ...w, display: `${op.to}${op.to.endsWith(trail) ? "" : trail}`, corrected: { from: w.display, reason: op.reason } };
          }),
        }));
        if (!hits) throw new Error(`no caption word "${op.from}"${near !== null ? ` near ${op.at}` : ""}`);
        changes.push({ path: "captions.words", op: "caption-correct", reason: `${reason} ("${op.from}" → "${op.to}" ×${hits}, timing unchanged)` });
        invalidated.add("captions");
        break;
      }
      case "voice-chain": {
        const chain = { ...plan.audio.voice.chain };
        if (op.denoise !== undefined) chain.denoise = op.denoise;
        if (op.deess !== undefined) chain.deess = op.deess;
        if (op.compress !== undefined) chain.compress = op.compress;
        if (op.highpassHz !== undefined) chain.highpassHz = op.highpassHz;
        plan.audio.voice = { ...plan.audio.voice, chain };
        changes.push({ path: "audio.voice.chain", op: "voice-chain", reason: `${reason} (denoise ${chain.denoise}, de-ess ${chain.deess}, compress ${chain.compress}, high-pass ${chain.highpassHz ?? "off"})` });
        invalidated.add("audio");
        break;
      }
      case "music-gain": {
        if (plan.audio.music.mode === "none") throw new Error("this edit has no music bed");
        plan.audio.music = { ...plan.audio.music, gainDb: (plan.audio.music.gainDb ?? 0) + op.db };
        changes.push({ path: "audio.music.gainDb", op: "music-gain", reason: `${reason} (${op.db > 0 ? "+" : ""}${op.db} dB, voice unchanged)` });
        invalidated.add("audio");
        break;
      }
      case "caption-zone": {
        const a = parseTimecode(op.from);
        const b = parseTimecode(op.to);
        if (plan.captions) {
          plan.captions.chunks = plan.captions.chunks.map((c) => (c.outStart < b && c.outEnd > a ? { ...c, zoneOverride: { y0: op.y0, y1: op.y1, reason: op.reason } } : c));
        }
        changes.push({ path: "captions.zoneOverride", op: "caption-zone", reason: `${reason}: ${op.reason}` });
        invalidated.add("captions");
        invalidated.add("video");
        break;
      }
    }
  }
  // Captions follow every timing change (time map), never the old caption times.
  if (invalidated.has("captions") && !changes.some((c) => c.op.startsWith("caption"))) plan = recaption(plan, ctx);
  plan = mergeRuns(plan);
  const next = EditPlanSchema.parse({
    ...plan,
    version: base.version + 1,
    parentVersion: base.version,
    createdAt: new Date().toISOString(),
    createdBy: "user-revision",
    changeSummary: reason,
    changes,
  });
  return { plan: next, changes, invalidated: [...invalidated] };
}
