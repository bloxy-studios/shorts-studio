/**
 * Luxury Tech world camera: a pure function of time over graphics only.
 *
 * The camera looks at world point (x, y) with zoom s; that point lands on the
 * layout's anchor. Moves (glide, step, push, pull, whip) are evaluated per frame
 * at composition-generation time so the motion and its velocity-based blur come
 * from the same path, and resting/landing frames are exactly sharp.
 */

export interface CamState {
  x: number;
  y: number;
  s: number;
}

export type CamMoveKind = "step" | "push" | "pull" | "whip" | "hold";

export interface CamMove {
  kind: CamMoveKind;
  /** Run-relative start, seconds. */
  t0: number;
  /** Total duration, seconds (whip: depart + arrive). */
  dur: number;
  to: CamState;
  ease?: string;
  /** Whip only: departure share of the duration (preset 0.45 / 1.05). */
  departFrac?: number;
}

export interface Glide {
  /** Total zoom change across the run (preset max 0.04). */
  scaleDelta: number;
  /** Small vertical drift in world px across the run. */
  driftY: number;
  /** Run duration, seconds. */
  dur: number;
}

type Ease = (p: number) => number;

const clamp01 = (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : p);

/** GSAP-equivalent eases (powerN = polynomial of degree N+1). */
export function ease(name: string | undefined): Ease {
  const n = name ?? "power2.inOut";
  if (n === "none" || n === "linear") return (p) => clamp01(p);
  if (n === "sine.inOut") return (p) => -(Math.cos(Math.PI * clamp01(p)) - 1) / 2;
  if (n === "sine.in") return (p) => 1 - Math.cos((clamp01(p) * Math.PI) / 2);
  if (n === "sine.out") return (p) => Math.sin((clamp01(p) * Math.PI) / 2);
  const m = /^power([0-4])\.(in|out|inOut)$/.exec(n);
  if (!m) throw new Error(`unsupported ease "${n}"`);
  const k = Number(m[1]) + 1;
  switch (m[2]) {
    case "in":
      return (p) => clamp01(p) ** k;
    case "out":
      return (p) => 1 - (1 - clamp01(p)) ** k;
    default:
      return (p) => {
        const q = clamp01(p);
        return q < 0.5 ? (2 * q) ** k / 2 : 1 - (2 * (1 - q)) ** k / 2;
      };
  }
}

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

function lerpState(a: CamState, b: CamState, p: number): CamState {
  // Zoom interpolates geometrically so pushes feel even.
  return { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), s: a.s * (b.s / a.s) ** p };
}

/** Camera state at run-relative time t (seconds). Moves must not overlap. */
export function cameraAt(t: number, init: CamState, moves: CamMove[], glide: Glide | null = null): CamState {
  let state = init;
  for (const m of [...moves].sort((a, b) => a.t0 - b.t0)) {
    if (t <= m.t0) break;
    const p = (t - m.t0) / m.dur;
    if (m.kind === "whip") {
      const df = m.departFrac ?? 0.45 / 1.05;
      const mid = lerpState(state, m.to, 0.5);
      if (p >= 1) state = m.to;
      else if (p < df) state = lerpState(state, mid, ease("power3.in")(p / df));
      else state = lerpState(mid, m.to, ease("power3.out")((p - df) / (1 - df)));
    } else if (m.kind === "hold") {
      continue;
    } else {
      const e = ease(m.ease ?? (m.kind === "step" ? "power3.inOut" : "power2.inOut"));
      state = p >= 1 ? m.to : lerpState(state, m.to, e(p));
    }
    if (p < 1) break;
  }
  if (!glide || glide.dur <= 0) return state;
  const g = ease("sine.inOut")(t / glide.dur);
  return { x: state.x, y: state.y + glide.driftY * g, s: state.s * (1 + glide.scaleDelta * g) };
}

export interface WorldTransform {
  tx: number;
  ty: number;
  s: number;
}

/** CSS transform (origin 0 0) placing world point (x, y) at the anchor with zoom s. */
export function worldTransform(c: CamState, anchor: { x: number; y: number }): WorldTransform {
  return { tx: anchor.x - c.s * c.x, ty: anchor.y - c.s * c.y, s: c.s };
}

export interface BlurSample {
  /** Gaussian sigma (screen px) along x and y. */
  sx: number;
  sy: number;
  sigma: number;
  /** Screen speed (px/s) near the anchor. */
  speed: number;
}

/**
 * Velocity-based motion blur for the moving world layer.
 * sigma = 0.29 × displacement over the shutter (= 0.29 × speed × shutter / fps):
 * the Gaussian with the variance of a box shutter. Measured as the RMS screen
 * displacement of points around the anchor between shutter open and close.
 */
export function motionBlurAt(t: number, at: (t: number) => WorldTransform, fps: number, shutter: number, maxSigma: number, anchor: { x: number; y: number }): BlurSample {
  const half = shutter / fps / 2;
  const a = at(t - half);
  const b = at(t + half);
  const probes = [
    [0, 0],
    [-300, 0],
    [300, 0],
    [0, -300],
    [0, 300],
  ] as const;
  let dx2 = 0;
  let dy2 = 0;
  for (const [ox, oy] of probes) {
    // World point under this screen probe at the shutter midpoint.
    const mid = at(t);
    const wx = (anchor.x + ox - mid.tx) / mid.s;
    const wy = (anchor.y + oy - mid.ty) / mid.s;
    const dx = b.tx + b.s * wx - (a.tx + a.s * wx);
    const dy = b.ty + b.s * wy - (a.ty + a.s * wy);
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const lx = Math.sqrt(dx2 / probes.length);
  const ly = Math.sqrt(dy2 / probes.length);
  const len = Math.hypot(lx, ly);
  const sigma = Math.min(maxSigma, 0.29 * len);
  if (sigma < 0.35) return { sx: 0, sy: 0, sigma: 0, speed: (len * fps) / shutter };
  return { sx: (sigma * lx) / len, sy: (sigma * ly) / len, sigma, speed: (len * fps) / shutter };
}

export interface CameraFrame {
  frame: number;
  t: number;
  transform: WorldTransform;
  blur: BlurSample;
}

/** Per-frame world transform and blur for a run of `frames` frames at `fps`. */
export function sampleCamera(opts: {
  frames: number;
  fps: number;
  init: CamState;
  moves: CamMove[];
  glide: Glide | null;
  anchor: { x: number; y: number };
  shutter: number;
  maxSigma: number;
  blur: boolean;
}): CameraFrame[] {
  const at = (t: number) => worldTransform(cameraAt(Math.max(0, t), opts.init, opts.moves, opts.glide), opts.anchor);
  const out: CameraFrame[] = [];
  for (let k = 0; k < opts.frames; k++) {
    const t = k / opts.fps;
    const blur = opts.blur && k > 0 ? motionBlurAt(t, at, opts.fps, opts.shutter, opts.maxSigma, opts.anchor) : { sx: 0, sy: 0, sigma: 0, speed: 0 };
    out.push({ frame: k, t, transform: at(t), blur });
  }
  return out;
}

/** Whip midpoint (run-relative seconds) — the whoosh peak must land here. */
export function whipMidpoint(m: CamMove): number {
  return m.t0 + m.dur * (m.departFrac ?? 0.45 / 1.05);
}
