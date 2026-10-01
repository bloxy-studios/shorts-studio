/**
 * Canonical time representation.
 *
 * All timeline values are integer "flicks" (1/705,600,000 s). A flick divides
 * evenly into every common video rate (23.976, 24, 25, 29.97, 30, 50, 59.94, 60,
 * 120, 240 fps) and audio rate (8k–192k, 44.1k), so frame and sample boundaries
 * are exact integers and repeated arithmetic never drifts. JavaScript numbers are
 * exact integers up to 2^53, i.e. ~147 days of timeline.
 */

export const FLICKS_PER_SECOND = 705_600_000;

/** Integer flicks. */
export type Flicks = number;

export interface Rational {
  num: number;
  den: number;
}

export type RoundMode = "floor" | "round" | "ceil";

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

export function rational(num: number, den = 1): Rational {
  if (!Number.isInteger(num) || !Number.isInteger(den) || den <= 0 || num <= 0) {
    throw new RangeError(`invalid rational ${num}/${den}`);
  }
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

/** Parses ffprobe-style rates such as "30000/1001", "60/1", "25". */
export function parseRational(text: string): Rational {
  const trimmed = text.trim();
  const [n, d] = trimmed.includes("/") ? trimmed.split("/") : [trimmed, "1"];
  const num = Number(n);
  const den = Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) {
    throw new RangeError(`cannot parse rate "${text}"`);
  }
  if (Number.isInteger(num) && Number.isInteger(den)) return rational(num, den);
  // decimal rate like "29.97": snap to a known NTSC rational when close, else scale.
  const value = num / den;
  for (const base of [24, 30, 60, 120]) {
    if (Math.abs(value - (base * 1000) / 1001) < 0.005) return rational(base * 1000, 1001);
  }
  return rational(Math.round(value * 1000), 1000);
}

export function rationalToNumber(r: Rational): number {
  return r.num / r.den;
}

export function formatRational(r: Rational): string {
  return r.den === 1 ? `${r.num}` : `${r.num}/${r.den}`;
}

export function assertFlicks(value: number, label = "time"): Flicks {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be an integer flick count, got ${value}`);
  }
  return value;
}

/** Flicks per output frame. Throws when the rate is not representable exactly. */
export function flicksPerFrame(fps: Rational): number {
  const value = (FLICKS_PER_SECOND * fps.den) / fps.num;
  if (!Number.isInteger(value)) {
    throw new RangeError(`frame rate ${formatRational(fps)} is not exactly representable in flicks`);
  }
  return value;
}

export function flicksPerSample(sampleRate: number): number {
  const value = FLICKS_PER_SECOND / sampleRate;
  if (!Number.isInteger(value)) {
    throw new RangeError(`sample rate ${sampleRate} is not exactly representable in flicks`);
  }
  return value;
}

/** Audio samples per video frame, or null when not an integer (e.g. 48 kHz at 29.97 fps). */
export function samplesPerFrame(fps: Rational, sampleRate: number): number | null {
  const value = (sampleRate * fps.den) / fps.num;
  return Number.isInteger(value) ? value : null;
}

export function secondsToFlicks(seconds: number): Flicks {
  return Math.round(seconds * FLICKS_PER_SECOND);
}

export function flicksToSeconds(flicks: Flicks): number {
  return flicks / FLICKS_PER_SECOND;
}

export function msToFlicks(ms: number): Flicks {
  return Math.round((ms * FLICKS_PER_SECOND) / 1000);
}

export function flicksToMs(flicks: Flicks): number {
  return (flicks * 1000) / FLICKS_PER_SECOND;
}

function roundBy(value: number, mode: RoundMode): number {
  if (mode === "floor") return Math.floor(value);
  if (mode === "ceil") return Math.ceil(value);
  return Math.floor(value + 0.5);
}

/** Integer division helper that is exact for integer operands below 2^53. */
function divide(a: number, b: number, mode: RoundMode): number {
  const q = Math.trunc(a / b);
  const r = a - q * b;
  if (r === 0) return q;
  const exact = a / b;
  return roundBy(exact, mode);
}

export function framesToFlicks(frames: number, fps: Rational): Flicks {
  return frames * flicksPerFrame(fps);
}

export function flicksToFrameIndex(flicks: Flicks, fps: Rational, mode: RoundMode = "floor"): number {
  return divide(flicks, flicksPerFrame(fps), mode);
}

export function quantizeToFrame(flicks: Flicks, fps: Rational, mode: RoundMode = "round"): Flicks {
  return framesToFlicks(flicksToFrameIndex(flicks, fps, mode), fps);
}

export function isFrameAligned(flicks: Flicks, fps: Rational): boolean {
  return flicks % flicksPerFrame(fps) === 0;
}

export function samplesToFlicks(samples: number, sampleRate: number): Flicks {
  return samples * flicksPerSample(sampleRate);
}

export function flicksToSamples(flicks: Flicks, sampleRate: number, mode: RoundMode = "round"): number {
  return divide(flicks, flicksPerSample(sampleRate), mode);
}

export function quantizeToSample(flicks: Flicks, sampleRate: number, mode: RoundMode = "round"): Flicks {
  return samplesToFlicks(flicksToSamples(flicks, sampleRate, mode), sampleRate);
}

export function isSampleAligned(flicks: Flicks, sampleRate: number): boolean {
  return flicks % flicksPerSample(sampleRate) === 0;
}

/** "HH:MM:SS.mmm" (hours omitted when zero unless forced). */
export function formatTimecode(flicks: Flicks, forceHours = false): string {
  const negative = flicks < 0;
  const totalMs = Math.round(Math.abs(flicksToMs(flicks)));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (v: number, n = 2) => `${v}`.padStart(n, "0");
  const body = h > 0 || forceHours ? `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}` : `${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
  return negative ? `-${body}` : body;
}

/** SRT style "HH:MM:SS,mmm". */
export function formatSrtTime(flicks: Flicks): string {
  return formatTimecode(Math.max(0, flicks), true).replace(".", ",");
}

/** WebVTT style "HH:MM:SS.mmm". */
export function formatVttTime(flicks: Flicks): string {
  return formatTimecode(Math.max(0, flicks), true);
}

/**
 * Parses user-facing time references: "18", "18s", "0:18", "00:18", "1:02.5",
 * "01:02:03.250", "1m2s", "250ms", "1h2m3.5s".
 */
export function parseTimecode(text: string): Flicks {
  const t = text.trim().toLowerCase();
  if (t.length === 0) throw new RangeError("empty time reference");
  const ms = /^(\d+(?:\.\d+)?)ms$/.exec(t);
  if (ms) return msToFlicks(Number(ms[1]));
  const unit = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?$/.exec(t);
  if (unit && (unit[1] || unit[2] || unit[3])) {
    const seconds = Number(unit[1] ?? 0) * 3600 + Number(unit[2] ?? 0) * 60 + Number(unit[3] ?? 0);
    return secondsToFlicks(seconds);
  }
  const parts = t.replace(",", ".").split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+(?:\.\d+)?$/.test(p))) {
    throw new RangeError(`cannot parse time reference "${text}"`);
  }
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + Number(p);
  return secondsToFlicks(seconds);
}
