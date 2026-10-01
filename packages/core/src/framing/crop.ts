import type { Flicks } from "../time.ts";
import { msToFlicks } from "../time.ts";
import type { Box } from "../schema/common.ts";
import type { FaceTrack } from "../schema/analysis.ts";
import type { CropKeyframe } from "../schema/editplan.ts";
import type { ActiveSpeaker } from "./speakers.ts";

export interface Frame {
  width: number;
  height: number;
}

export interface CropOpts {
  aspect: number;
  headroomFrac: number;
  eyeLineFrac: number;
  scale?: number;
}

/** Largest crop of the given aspect that fits the frame, divided by `scale` (punch-in). */
export function cropSize(frame: Frame, aspect: number, scale = 1): { w: number; h: number } {
  let h = frame.height;
  let w = h * aspect;
  if (w > frame.width) {
    w = frame.width;
    h = w / aspect;
  }
  return { w: w / scale, h: h / scale };
}

function clampBox(b: Box, frame: Frame): Box {
  return {
    x: Math.min(Math.max(b.x, 0), frame.width - b.w),
    y: Math.min(Math.max(b.y, 0), frame.height - b.h),
    w: b.w,
    h: b.h,
  };
}

/** Crop centred on a point with the eye line at `eyeLineFrac` of the crop height. */
export function cropAt(cx: number, eyeY: number, frame: Frame, opts: CropOpts): Box {
  const { w, h } = cropSize(frame, opts.aspect, opts.scale ?? 1);
  const cy = eyeY + h * (0.5 - opts.eyeLineFrac);
  return clampBox({ x: cx - w / 2, y: cy - h / 2, w, h }, frame);
}

function eyeY(s: FaceTrack["samples"][number]): number {
  return s.landmarks ? (s.landmarks[1]! + s.landmarks[3]!) / 2 : s.box.y + s.box.h * 0.4;
}

/**
 * Two-shot: one crop containing every given face with margins, or null when the
 * faces are too far apart for a single crop of this aspect.
 */
export function groupCrop(faces: Box[], frame: Frame, opts: CropOpts): Box | null {
  if (faces.length === 0) return null;
  const { w, h } = cropSize(frame, opts.aspect, opts.scale ?? 1);
  const x0 = Math.min(...faces.map((f) => f.x));
  const x1 = Math.max(...faces.map((f) => f.x + f.w));
  const margin = Math.max(...faces.map((f) => f.w)) * 0.35;
  if (x1 - x0 + 2 * margin > w) return null;
  const cx = (x0 + x1) / 2;
  const eye = Math.min(...faces.map((f) => f.y + f.h * 0.4));
  return cropAt(cx, eye, frame, opts);
}

export interface FollowOpts extends CropOpts {
  deadZoneFrac: number;
  maxVelocityFracPerSec: number;
  smoothingMs: number;
}

/**
 * Velocity-limited follow path for one face: holds inside a dead zone, moves no
 * faster than maxVelocity, smooths with an exponential filter, and never leaves
 * the source frame. Times are output-time flicks via `toOut`.
 */
export function followPath(track: FaceTrack, start: Flicks, end: Flicks, frame: Frame, opts: FollowOpts, toOut: (src: Flicks) => Flicks): CropKeyframe[] {
  const samples = track.samples.filter((s) => s.t >= start && s.t < end);
  if (samples.length === 0) return [];
  const size = cropSize(frame, opts.aspect, opts.scale ?? 1);
  const dead = size.w * opts.deadZoneFrac;
  const maxStepPerSec = size.w * opts.maxVelocityFracPerSec;
  const alpha = (dt: number) => (opts.smoothingMs <= 0 ? 1 : 1 - Math.exp(-dt / (opts.smoothingMs / 1000)));
  let cx = samples[0]!.box.x + samples[0]!.box.w / 2;
  let ey = eyeY(samples[0]!);
  let lastT = samples[0]!.t;
  const keys: CropKeyframe[] = [{ t: toOut(samples[0]!.t), box: cropAt(cx, ey, frame, opts), hold: false }];
  for (const s of samples.slice(1)) {
    const dt = (s.t - lastT) / 705_600_000;
    lastT = s.t;
    const tx = s.box.x + s.box.w / 2;
    const ty = eyeY(s);
    const dx = tx - cx;
    if (Math.abs(dx) > dead) {
      const want = dx - Math.sign(dx) * dead;
      const step = Math.max(-maxStepPerSec * dt, Math.min(maxStepPerSec * dt, want * alpha(dt)));
      cx += step;
    }
    const dy = ty - ey;
    if (Math.abs(dy) > dead * 0.6) ey += Math.max(-maxStepPerSec * dt, Math.min(maxStepPerSec * dt, (dy - Math.sign(dy) * dead * 0.6) * alpha(dt)));
    const box = cropAt(cx, ey, frame, opts);
    const prev = keys[keys.length - 1]!.box;
    if (Math.abs(prev.x - box.x) > 0.5 || Math.abs(prev.y - box.y) > 0.5) keys.push({ t: toOut(s.t), box, hold: false });
  }
  return keys;
}

export type ShotKind = "single" | "two-shot" | "stack" | "wide";

export interface Shot {
  start: Flicks;
  end: Flicks;
  kind: ShotKind;
  trackId: string | null;
  reason: string;
  confidence: number;
}

/**
 * Turns active-speaker estimates into shots with switching hysteresis: a switch
 * happens only at a verified turn of at least `hysteresisMs`, each shot lasts at
 * least `minHoldMs`, rapid alternation becomes a stack, and uncertainty falls back
 * to the configured safe layout instead of guessing a face.
 */
export function planShots(
  span: { start: Flicks; end: Flicks },
  speakers: readonly ActiveSpeaker[],
  opts: { minHoldMs: number; hysteresisMs: number; minConfidence: number; fallback: ShotKind; rapidPolicy: Exclude<ShotKind, "single"> | "switch" },
): Shot[] {
  const minHold = msToFlicks(opts.minHoldMs);
  const hyst = msToFlicks(opts.hysteresisMs);
  const turns = speakers.filter((s) => s.end > span.start && s.start < span.end);
  const raw: Shot[] = [];
  for (const t of turns) {
    const start = Math.max(t.start, span.start);
    const end = Math.min(t.end, span.end);
    const ok = t.trackId !== null && t.confidence >= opts.minConfidence;
    raw.push(
      ok
        ? { start, end, kind: "single", trackId: t.trackId, reason: t.evidence, confidence: t.confidence }
        : { start, end, kind: opts.fallback, trackId: null, reason: `${t.state}: ${t.evidence}`, confidence: t.confidence },
    );
  }
  if (raw.length === 0) return [{ start: span.start, end: span.end, kind: opts.fallback, trackId: null, reason: "no speech turns in this span", confidence: 0.5 }];
  // Fill gaps between turns by extending the previous shot (framing holds through pauses).
  const filled: Shot[] = [];
  for (const s of raw) {
    const prev = filled[filled.length - 1];
    if (!prev) filled.push({ ...s, start: span.start });
    else {
      prev.end = s.start;
      filled.push(s);
    }
  }
  filled[filled.length - 1]!.end = span.end;
  // Hysteresis + min hold: absorb shots that are too short or differ only briefly.
  const merged: Shot[] = [];
  for (const s of filled) {
    const prev = merged[merged.length - 1];
    const same = prev && prev.kind === s.kind && prev.trackId === s.trackId;
    const tooShort = s.end - s.start < hyst || (prev && prev.end - prev.start < minHold);
    if (prev && (same || tooShort)) {
      prev.end = s.end;
      if (!same && tooShort) prev.reason = `${prev.reason}; held through a brief ${s.kind === "single" ? `turn by ${s.trackId}` : s.kind} (hysteresis)`;
    } else merged.push({ ...s });
  }
  // Rapid alternation: ≥ 3 speaker changes inside 8 s → one stable two-person layout.
  if (opts.rapidPolicy !== "switch") {
    for (let i = 0; i + 2 < merged.length; i++) {
      const a = merged[i]!;
      const c = merged[i + 2]!;
      if (a.kind === "single" && merged[i + 1]!.kind === "single" && c.kind === "single" && c.end - a.start <= msToFlicks(8000) && a.trackId !== merged[i + 1]!.trackId) {
        const stack: Shot = { start: a.start, end: c.end, kind: opts.rapidPolicy, trackId: null, reason: "rapid alternation between speakers — stable two-person layout instead of frantic switching", confidence: 0.7 };
        merged.splice(i, 3, stack);
      }
    }
    // Coalesce adjacent identical non-single shots.
    for (let i = merged.length - 1; i > 0; i--) {
      const a = merged[i - 1]!;
      const b = merged[i]!;
      if (a.kind === b.kind && a.trackId === b.trackId) {
        a.end = b.end;
        merged.splice(i, 1);
      }
    }
  }
  return merged;
}
