import { checkTiling, containsInterval } from "../interval.ts";
import { TimeMap } from "../timemap.ts";
import { flicksPerFrame, flicksPerSample, formatTimecode, isFrameAligned, isSampleAligned } from "../time.ts";
import type { EditPlan } from "../schema/editplan.ts";
import { buildTimeMapPieces, clockMapper } from "./timeline.ts";

export interface PlanIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  ids: string[];
}

export interface PlanContext {
  /** Source frame sizes (upright) for crop bound checks. */
  sourceFrames?: ReadonlyMap<string, { width: number; height: number; durationFlicks: number }>;
  /** Transcript word ids that captions may reference. */
  sourceWordIds?: ReadonlySet<string>;
}

/**
 * Deterministic structural invariants every renderer relies on. Errors block
 * rendering; warnings are reported and surfaced to QA.
 */
export function validatePlan(plan: EditPlan, ctx: PlanContext = {}): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const err = (code: string, message: string, ids: string[] = []) => issues.push({ code, severity: "error", message, ids });
  const warn = (code: string, message: string, ids: string[] = []) => issues.push({ code, severity: "warning", message, ids });

  const { fps, sampleRate } = plan.output;
  let frame: number;
  let sample: number;
  try {
    frame = flicksPerFrame(fps);
    sample = flicksPerSample(sampleRate);
  } catch (e) {
    err("output.rate", (e as Error).message);
    return issues;
  }
  const END = plan.output.durationFlicks;

  // Output extent.
  if (!isFrameAligned(END, fps)) err("output.end-unaligned", `END ${END} is not on the ${fps.num}/${fps.den} frame grid`);
  if (END / frame !== plan.output.frameCount) err("output.frame-count", `frameCount ${plan.output.frameCount} != END/frame ${END / frame}`);
  if (plan.output.voiceEndFlicks > END) err("output.voice-after-end", "voice ends after END");
  if (END - plan.output.voiceEndFlicks >= frame) warn("output.blank-tail", `END is ${(END - plan.output.voiceEndFlicks) / frame} frames after the voice end`);

  // Picture segments tile [0, END) on the frame grid.
  for (const seg of plan.segments) {
    const p = seg.picture;
    if (!isFrameAligned(p.outStart, fps) || !isFrameAligned(p.outEnd, fps)) err("segment.picture-unaligned", `${seg.id} picture cut is off the frame grid`, [seg.id]);
    if (p.srcStart < 0) err("segment.negative-source", `${seg.id} reads before source zero`, [seg.id]);
    const src = ctx.sourceFrames?.get(p.sourceId);
    if (src && p.srcStart + (p.outEnd - p.outStart) > src.durationFlicks + frame) {
      err("segment.past-source-end", `${seg.id} reads past the end of ${p.sourceId}`, [seg.id]);
    }
    for (const a of seg.audio) {
      if (!isSampleAligned(a.outStart, sampleRate) || !isSampleAligned(a.outEnd, sampleRate)) {
        err("audio.unaligned", `${seg.id}/${a.id} is not sample-aligned at ${sampleRate} Hz`, [seg.id, a.id]);
      }
      if (a.outStart < 0) err("audio.negative-time", `${seg.id}/${a.id} starts before timeline zero (negative J-cut)`, [seg.id, a.id]);
      if (a.outEnd > END) err("audio.after-end", `${seg.id}/${a.id} ends after END`, [seg.id, a.id]);
      if (a.outEnd <= a.outStart) err("audio.empty", `${seg.id}/${a.id} is empty`, [seg.id, a.id]);
      if (a.fadeInFlicks + a.fadeOutFlicks > a.outEnd - a.outStart) err("audio.fades", `${seg.id}/${a.id} fades exceed its length`, [seg.id, a.id]);
    }
  }
  for (const t of checkTiling(
    plan.segments.map((s) => ({ id: s.id, start: s.picture.outStart, end: s.picture.outEnd })),
    { start: 0, end: END },
  )) {
    err(`picture.${t.kind}`, `picture timeline ${t.message} at ${formatTimecode(t.at)}`, t.ids);
  }

  // Time map must be exactly what the segments imply (traceability).
  const rebuilt = buildTimeMapPieces(plan.segments);
  const stored = JSON.stringify([...plan.timeMap].sort((a, b) => a.id.localeCompare(b.id)));
  const derived = JSON.stringify([...rebuilt].sort((a, b) => a.id.localeCompare(b.id)));
  if (stored !== derived) err("timemap.stale", "stored timeMap does not match segments; rebuild it");
  const map = new TimeMap(rebuilt);
  for (const i of map.validate()) err(`timemap.${i.kind}`, i.message, i.pieceIds);
  for (const s of map.syncErrors(Math.floor(sample / 2), clockMapper(plan.sources))) {
    err("sync.lip", `audio ${s.audioPieceId} is ${Math.round((s.errorFlicks / frame) * 100) / 100} frames out of sync with ${s.videoPieceId}`, [s.audioPieceId, s.videoPieceId]);
  }

  // Layout runs tile [0, END).
  for (const run of plan.layoutRuns) {
    if (!isFrameAligned(run.outStart, fps) || !isFrameAligned(run.outEnd, fps)) err("layout.unaligned", `${run.id} boundary is off the frame grid`, [run.id]);
    for (const slot of run.slots) {
      if (!plan.cropPaths.some((c) => c.id === slot.cropPathId)) err("layout.missing-crop", `${run.id} references missing crop ${slot.cropPathId}`, [run.id]);
    }
    if (run.graphicId && !plan.graphics.some((g) => g.id === run.graphicId)) err("layout.missing-graphic", `${run.id} references missing graphic ${run.graphicId}`, [run.id]);
  }
  for (const t of checkTiling(plan.layoutRuns.map((r) => ({ id: r.id, start: r.outStart, end: r.outEnd })), { start: 0, end: END })) {
    err(`layout.${t.kind}`, `layout runs: ${t.message}`, t.ids);
  }

  // Crop paths: aspect and source bounds.
  for (const c of plan.cropPaths) {
    const src = ctx.sourceFrames?.get(c.sourceId);
    for (const k of c.keyframes) {
      const aspect = k.box.w / k.box.h;
      if (Math.abs(aspect - c.aspect) / c.aspect > 0.01) err("crop.aspect", `${c.id} keyframe aspect ${aspect.toFixed(4)} != ${c.aspect.toFixed(4)}`, [c.id]);
      if (src) {
        const eps = 0.5;
        if (k.box.x < -eps || k.box.y < -eps || k.box.x + k.box.w > src.width + eps || k.box.y + k.box.h > src.height + eps) {
          err("crop.bounds", `${c.id} keyframe at ${formatTimecode(k.t)} leaves the ${src.width}x${src.height} source frame`, [c.id]);
        }
      }
      if (k.t > END) err("crop.after-end", `${c.id} has a keyframe after END`, [c.id]);
    }
  }

  // Captions: sorted, non-overlapping, inside [minStart, END], words traceable.
  if (plan.captions) {
    const cap = plan.captions;
    let prevEnd = -1;
    const seenWords = new Set<string>();
    for (const c of cap.chunks) {
      if (c.outStart < cap.minStartFlicks) err("captions.before-min", `${c.id} starts before the first allowed caption frame`, [c.id]);
      if (c.outEnd > END) err("captions.after-end", `${c.id} ends after END (stale caption)`, [c.id]);
      if (c.outEnd <= c.outStart) err("captions.empty", `${c.id} has no duration`, [c.id]);
      if (c.outStart < prevEnd) err("captions.overlap", `${c.id} overlaps the previous caption`, [c.id]);
      prevEnd = c.outEnd;
      const lineWordIds = c.lines.flat();
      const wordIds = c.words.map((w) => w.id);
      if (JSON.stringify(lineWordIds) !== JSON.stringify(wordIds)) err("captions.lines", `${c.id} lines do not cover its words in order`, [c.id]);
      for (const w of c.words) {
        if (seenWords.has(w.id)) err("captions.duplicate-word", `${w.id} appears in more than one chunk`, [c.id, w.id]);
        seenWords.add(w.id);
        if (ctx.sourceWordIds && !ctx.sourceWordIds.has(w.sourceWordId)) err("captions.untraceable", `${w.id} references unknown source word ${w.sourceWordId}`, [c.id, w.id]);
        if (!containsInterval({ start: c.outStart - frame, end: c.outEnd + frame }, { start: w.outStart, end: Math.min(w.outEnd, c.outEnd) })) {
          warn("captions.word-outside", `${w.id} "${w.text}" is spoken outside its chunk ${c.id}`, [c.id, w.id]);
        }
      }
    }
  }

  for (const t of plan.titleOverlays) {
    if (t.outStart < 0 || t.outEnd > END || t.outEnd <= t.outStart) err("title.range", `${t.id} is outside [0, END)`, [t.id]);
  }
  for (const g of plan.graphics) {
    if (!plan.layoutRuns.some((r) => r.id === g.runId)) err("graphic.run", `${g.id} belongs to missing run ${g.runId}`, [g.id]);
  }
  for (const s of plan.audio.sfx) {
    if (s.t < 0 || s.t >= END) err("sfx.range", `${s.id} at ${formatTimecode(s.t)} is outside [0, END)`, [s.id]);
  }
  return issues;
}

export function hasErrors(issues: readonly PlanIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
