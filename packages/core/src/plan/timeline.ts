import type { Flicks, Rational } from "../time.ts";
import { flicksPerFrame, flicksToFrameIndex, framesToFlicks } from "../time.ts";
import { TimeMap, type TimeMapPiece } from "../timemap.ts";
import type { EditPlan, PlanSource, TimelineSegment } from "../schema/editplan.ts";

/** Derives the explicit piecewise source-to-output map from timeline segments. */
export function buildTimeMapPieces(segments: readonly TimelineSegment[]): TimeMapPiece[] {
  const pieces: TimeMapPiece[] = [];
  for (const seg of segments) {
    pieces.push({
      id: `${seg.id}.v`,
      track: "video",
      segmentId: seg.id,
      sourceId: seg.picture.sourceId,
      outStart: seg.picture.outStart,
      outEnd: seg.picture.outEnd,
      srcStart: seg.picture.srcStart,
      rate: seg.picture.rate ?? { num: 1, den: 1 },
    });
    for (const clip of seg.audio) {
      pieces.push({
        id: `${seg.id}.${clip.id}`,
        track: "audio",
        segmentId: seg.id,
        sourceId: clip.sourceId,
        outStart: clip.outStart,
        outEnd: clip.outEnd,
        srcStart: clip.srcStart,
        rate: { num: 1, den: 1 },
      });
    }
  }
  return pieces;
}

export function timeMapOf(plan: Pick<EditPlan, "segments">): TimeMap {
  return new TimeMap(buildTimeMapPieces(plan.segments));
}

/**
 * Converts a source time to its recording clock. A mic aligned to the camera
 * with `clock` maps back to camera time: refTime = (src - offset - drift*anchor)/(1+drift).
 */
export function clockMapper(sources: readonly PlanSource[]) {
  const bySource = new Map(sources.map((s) => [s.sourceId, s]));
  return (sourceId: string, srcTime: Flicks): { clockId: string; time: Flicks } => {
    const s = bySource.get(sourceId);
    if (!s?.clock) return { clockId: sourceId, time: srcTime };
    const drift = s.clock.driftPpm * 1e-6;
    const refTime = (srcTime - s.clock.offsetFlicks + drift * s.clock.anchorFlicks) / (1 + drift);
    return { clockId: s.clock.refSourceId, time: Math.round(refTime) };
  };
}

/** Maps a reference-clock time into a clock-aligned source (inverse of clockMapper). */
export function refToSource(source: PlanSource, refTime: Flicks): Flicks {
  if (!source.clock) return refTime;
  const drift = source.clock.driftPpm * 1e-6;
  return Math.round(refTime + source.clock.offsetFlicks + drift * (refTime - source.clock.anchorFlicks));
}

export interface TimelineExtent {
  voiceEnd: Flicks;
  end: Flicks;
  frameCount: number;
}

/**
 * The meaningful voice ending defines the timeline: END is the voice end rounded
 * up to a whole output frame. Every stem and layer must share END exactly.
 */
export function computeExtent(segments: readonly TimelineSegment[], fps: Rational): TimelineExtent {
  let voiceEnd = 0;
  for (const seg of segments) {
    for (const clip of seg.audio) {
      if (clip.role === "voice" || clip.role === "source-mix") voiceEnd = Math.max(voiceEnd, clip.outEnd);
    }
  }
  if (voiceEnd === 0) {
    for (const seg of segments) voiceEnd = Math.max(voiceEnd, seg.picture.outEnd);
  }
  const frameCount = flicksToFrameIndex(voiceEnd, fps, "ceil");
  return { voiceEnd, end: framesToFlicks(frameCount, fps), frameCount };
}

export function frameFlicks(fps: Rational): number {
  return flicksPerFrame(fps);
}
