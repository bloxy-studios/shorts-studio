import type { Flicks, Rational } from "./time.ts";
import { FLICKS_PER_SECOND } from "./time.ts";
import { overlaps, type Interval } from "./interval.ts";

/**
 * One linear piece of the explicit source-to-output map.
 * Output interval [outStart, outEnd) plays source `sourceId` beginning at
 * `srcStart`, advancing `rate` source seconds per output second (1/1 = realtime).
 */
export interface TimeMapPiece {
  id: string;
  track: "video" | "audio";
  segmentId: string;
  sourceId: string;
  outStart: Flicks;
  outEnd: Flicks;
  srcStart: Flicks;
  rate: Rational;
}

export interface SourcePoint {
  pieceId: string;
  segmentId: string;
  sourceId: string;
  srcTime: Flicks;
}

export interface MappedInterval {
  pieceId: string;
  segmentId: string;
  outStart: Flicks;
  outEnd: Flicks;
  /** True when only part of the source interval is present in this piece. */
  partial: boolean;
}

function scale(delta: Flicks, rate: Rational): Flicks {
  return Math.round((delta * rate.num) / rate.den);
}

function unscale(delta: Flicks, rate: Rational): Flicks {
  return Math.round((delta * rate.den) / rate.num);
}

export function pieceSrcEnd(p: TimeMapPiece): Flicks {
  return p.srcStart + scale(p.outEnd - p.outStart, p.rate);
}

export interface TimeMapIssue {
  kind: "invalid-piece" | "video-overlap" | "negative-output" | "negative-source";
  pieceIds: string[];
  message: string;
}

export class TimeMap {
  readonly pieces: readonly TimeMapPiece[];

  constructor(pieces: TimeMapPiece[]) {
    this.pieces = [...pieces].sort((a, b) => a.outStart - b.outStart || a.id.localeCompare(b.id));
  }

  /** Structural checks. Audio pieces may overlap (J-cut crossfades); video pieces may not. */
  validate(): TimeMapIssue[] {
    const issues: TimeMapIssue[] = [];
    for (const p of this.pieces) {
      if (!Number.isSafeInteger(p.outStart) || !Number.isSafeInteger(p.outEnd) || p.outEnd <= p.outStart) {
        issues.push({ kind: "invalid-piece", pieceIds: [p.id], message: `${p.id} has an empty or non-integer output interval` });
      }
      if (p.outStart < 0) issues.push({ kind: "negative-output", pieceIds: [p.id], message: `${p.id} starts before timeline zero` });
      if (p.srcStart < 0) issues.push({ kind: "negative-source", pieceIds: [p.id], message: `${p.id} reads before source zero` });
    }
    const video = this.pieces.filter((p) => p.track === "video");
    for (let i = 1; i < video.length; i++) {
      const a = video[i - 1]!;
      const b = video[i]!;
      if (overlaps({ start: a.outStart, end: a.outEnd }, { start: b.outStart, end: b.outEnd })) {
        issues.push({ kind: "video-overlap", pieceIds: [a.id, b.id], message: `video pieces ${a.id} and ${b.id} overlap` });
      }
    }
    return issues;
  }

  /** All source points active at output time t on a track (audio can return several). */
  outToSrc(track: "video" | "audio", t: Flicks): SourcePoint[] {
    const out: SourcePoint[] = [];
    for (const p of this.pieces) {
      if (p.track !== track || t < p.outStart || t >= p.outEnd) continue;
      out.push({ pieceId: p.id, segmentId: p.segmentId, sourceId: p.sourceId, srcTime: p.srcStart + scale(t - p.outStart, p.rate) });
    }
    return out;
  }

  /** Every output time at which a source instant is presented (sources may be reused). */
  srcToOut(track: "video" | "audio", sourceId: string, srcTime: Flicks): Flicks[] {
    const out: Flicks[] = [];
    for (const p of this.pieces) {
      if (p.track !== track || p.sourceId !== sourceId) continue;
      const srcEnd = pieceSrcEnd(p);
      if (srcTime < p.srcStart || srcTime >= srcEnd) continue;
      out.push(p.outStart + unscale(srcTime - p.srcStart, p.rate));
    }
    return out;
  }

  /**
   * Maps a source interval (e.g. a transcript word) onto the output. Returns one
   * entry per piece that presents any part of it; `partial` flags truncation.
   */
  mapSourceInterval(track: "video" | "audio", sourceId: string, src: Interval): MappedInterval[] {
    const out: MappedInterval[] = [];
    for (const p of this.pieces) {
      if (p.track !== track || p.sourceId !== sourceId) continue;
      const srcEnd = pieceSrcEnd(p);
      const start = Math.max(src.start, p.srcStart);
      const end = Math.min(src.end, srcEnd);
      if (end <= start) continue;
      out.push({
        pieceId: p.id,
        segmentId: p.segmentId,
        outStart: p.outStart + unscale(start - p.srcStart, p.rate),
        outEnd: p.outStart + unscale(end - p.srcStart, p.rate),
        partial: start > src.start || end < src.end,
      });
    }
    return out;
  }

  /** Output extent covered by a track. */
  extent(track: "video" | "audio"): Interval | null {
    const ps = this.pieces.filter((p) => p.track === track);
    if (ps.length === 0) return null;
    return { start: Math.min(...ps.map((p) => p.outStart)), end: Math.max(...ps.map((p) => p.outEnd)) };
  }

  /**
   * Lip-sync invariant: within a segment, audio and picture must present the same
   * recording instant at the same output time, so (out - clockTime) must match
   * between the segment's audio and video pieces. `toClock` converts a source
   * time to a shared recording clock (e.g. a separate mic aligned to the camera);
   * sources without a clock mapping are compared only with themselves.
   */
  syncErrors(
    toleranceFlicks = 0,
    toClock: (sourceId: string, srcTime: Flicks) => { clockId: string; time: Flicks } = (sourceId, srcTime) => ({ clockId: sourceId, time: srcTime }),
  ): Array<{ audioPieceId: string; videoPieceId: string; errorFlicks: Flicks }> {
    const errors: Array<{ audioPieceId: string; videoPieceId: string; errorFlicks: Flicks }> = [];
    const video = this.pieces.filter((p) => p.track === "video");
    for (const a of this.pieces.filter((p) => p.track === "audio")) {
      const ac = toClock(a.sourceId, a.srcStart);
      for (const v of video) {
        if (v.segmentId !== a.segmentId) continue;
        const vc = toClock(v.sourceId, v.srcStart);
        if (vc.clockId !== ac.clockId) continue;
        const err = a.outStart - ac.time - (v.outStart - vc.time);
        if (Math.abs(err) > toleranceFlicks) errors.push({ audioPieceId: a.id, videoPieceId: v.id, errorFlicks: err });
      }
    }
    return errors;
  }

  toJSON(): TimeMapPiece[] {
    return [...this.pieces];
  }
}

/** Convenience for reports: seconds with millisecond precision. */
export function describePiece(p: TimeMapPiece): string {
  const s = (f: Flicks) => (f / FLICKS_PER_SECOND).toFixed(3);
  return `${p.track}:${p.segmentId} out[${s(p.outStart)},${s(p.outEnd)}) <- ${p.sourceId}@${s(p.srcStart)} x${p.rate.num}/${p.rate.den}`;
}
