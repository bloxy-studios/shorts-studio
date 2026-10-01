/**
 * Luxury Tech layout-run planner (pure).
 *
 * Tiles [0, END) with three layouts — full camera, split (graphics above a camera
 * card with the head emerging) and full visual — following the preset's sequencing:
 * hook → split, CTA/outro → full camera, opinions → full camera when the presenter
 * looks at the lens, screen/source material → full visual, single card/list → split,
 * runs of at most ~8 s, no consecutive identical layouts, and camera footage only
 * while eye-contact evidence supports it.
 */
import { quantizeToFrame, type Flicks, type Rational } from "../time.ts";

export type LtLayout = "lt-full-camera" | "lt-split" | "lt-full-visual";
export type LineIntent = "hook" | "point" | "opinion" | "screen" | "card" | "list" | "cta" | "outro";
export type RunRole = "hook" | "body" | "outro";

export interface LtWord {
  id: string;
  start: Flicks;
  end: Flicks;
  text: string;
}

export interface LtLine {
  id: string;
  /** Picture interval of the line on the output timeline (lines tile [0, END)). */
  start: Flicks;
  end: Flicks;
  words: LtWord[];
  intent?: LineIntent;
}

export interface GazeEvidence {
  /** Share of evidence in [a, b) saying the presenter looks at the lens; null when there is no face evidence. */
  atLens(a: Flicks, b: Flicks): { fraction: number | null; samples: number };
  /** Start of the first sustained look-away inside [a, b), or null. */
  turnAway(a: Flicks, b: Flicks): Flicks | null;
}

export interface LtRunPlan {
  start: Flicks;
  end: Flicks;
  layout: LtLayout;
  role: RunRole;
  lineIds: string[];
  wordIds: string[];
  reason: string;
  exceptions: string[];
}

export interface LtLayoutInput {
  lines: LtLine[];
  end: Flicks;
  fps: Rational;
  gaze: GazeEvidence;
  /** Longest uninterrupted run (preset: ~8 s). */
  maxRunFlicks: Flicks;
  /** Shortest run worth a layout of its own. */
  minRunFlicks: Flicks;
  /** Minimum at-lens share for showing the camera. */
  atLensMin?: number;
  hasCta?: boolean;
}

export interface LtLayoutResult {
  runs: LtRunPlan[];
  exceptions: string[];
}

const CAMERA_LAYOUTS: ReadonlySet<LtLayout> = new Set(["lt-full-camera", "lt-split"]);

interface Draft {
  start: Flicks;
  end: Flicks;
  layout: LtLayout;
  role: RunRole;
  lineIds: string[];
  words: LtWord[];
  reasons: string[];
  exceptions: string[];
}

function intentLayout(intent: LineIntent, prev: LtLayout | null): { layout: LtLayout; why: string } {
  switch (intent) {
    case "hook":
      return { layout: "lt-split", why: "hook sentence → split" };
    case "cta":
    case "outro":
      return { layout: "lt-full-camera", why: `${intent} → full camera` };
    case "opinion":
      return { layout: "lt-full-camera", why: "opinion/direct-to-camera line → full camera" };
    case "screen":
      return { layout: "lt-full-visual", why: "screen/source/UI material → full visual" };
    case "card":
    case "list":
      return { layout: "lt-split", why: `single ${intent} → split` };
    default:
      return prev === "lt-full-visual" ? { layout: "lt-split", why: "point → split (alternating)" } : { layout: "lt-full-visual", why: "point → full visual (alternating)" };
  }
}

/** Frame-aligned cut in the gap between two words (never inside a word). */
function cutBetween(prev: LtWord, next: LtWord, fps: Rational): Flicks {
  const mid = Math.round((prev.end + next.start) / 2);
  let cut = quantizeToFrame(mid, fps, "round");
  if (cut > next.start) cut = quantizeToFrame(next.start, fps, "floor");
  if (cut < prev.end) cut = quantizeToFrame(prev.end, fps, "ceil");
  return cut;
}

function wordsIn(words: LtWord[], a: Flicks, b: Flicks): LtWord[] {
  return words.filter((w) => w.start >= a && w.start < b);
}

/** Best word gap to split a draft near `target` — prefers punctuation, then longer pauses. */
function bestSplit(d: Draft, target: Flicks, fps: Rational, minRun: Flicks): Flicks | null {
  let best: { cut: Flicks; score: number } | null = null;
  for (let i = 1; i < d.words.length; i++) {
    const prev = d.words[i - 1]!;
    const next = d.words[i]!;
    const cut = cutBetween(prev, next, fps);
    if (cut - d.start < minRun || d.end - cut < minRun) continue;
    const punct = /[.!?;:,]$/.test(prev.text) ? 1 : 0;
    const gapMs = (next.start - prev.end) / 705_600;
    const distance = Math.abs(cut - target) / Math.max(1, d.end - d.start);
    const score = punct * 1.5 + Math.min(gapMs, 400) / 400 - distance * 2;
    if (!best || score > best.score) best = { cut, score };
  }
  return best?.cut ?? null;
}

function alternate(layout: LtLayout, cameraOk: boolean): LtLayout {
  if (layout === "lt-full-visual") return cameraOk ? "lt-split" : "lt-full-visual";
  return "lt-full-visual";
}

export function planLuxuryLayout(input: LtLayoutInput): LtLayoutResult {
  const { lines, fps, gaze } = input;
  const atLensMin = input.atLensMin ?? 0.7;
  if (lines.length === 0) throw new Error("planLuxuryLayout: no lines");
  const exceptions: string[] = [];
  const cameraOk = (a: Flicks, b: Flicks): { ok: boolean; why: string } => {
    const g = gaze.atLens(a, b);
    if (g.fraction === null) return { ok: false, why: "no face evidence" };
    return g.fraction >= atLensMin ? { ok: true, why: `looks at lens (${Math.round(g.fraction * 100)}% of ${g.samples} samples)` } : { ok: false, why: `looks away (${Math.round(g.fraction * 100)}% at lens over ${g.samples} samples)` };
  };

  // 1. One draft per line from its intent.
  let drafts: Draft[] = [];
  lines.forEach((line, i) => {
    const last = i === lines.length - 1;
    const intent: LineIntent = line.intent ?? (i === 0 ? "hook" : last && lines.length >= 3 ? (input.hasCta ? "cta" : "outro") : "point");
    const role: RunRole = intent === "hook" ? "hook" : intent === "cta" || intent === "outro" ? "outro" : "body";
    const choice = intentLayout(intent, drafts.length ? drafts[drafts.length - 1]!.layout : null);
    drafts.push({ start: line.start, end: line.end, layout: choice.layout, role, lineIds: [line.id], words: line.words, reasons: [choice.why], exceptions: [] });
  });

  // 2. Eye-contact gate: camera only while the presenter looks at the lens.
  const gated: Draft[] = [];
  for (const d of drafts) {
    if (!CAMERA_LAYOUTS.has(d.layout)) {
      gated.push(d);
      continue;
    }
    const whole = cameraOk(d.start, d.end);
    if (whole.ok) {
      gated.push({ ...d, reasons: [...d.reasons, whole.why] });
      continue;
    }
    const turn = gaze.turnAway(d.start, d.end);
    const head = turn !== null ? cameraOk(d.start, turn) : { ok: false, why: "" };
    if (turn !== null && head.ok && turn - d.start >= input.minRunFlicks) {
      // Split near the word boundary before the turn; the rest becomes a full visual.
      const before = d.words.filter((w) => w.end <= turn);
      const after = d.words.filter((w) => w.start >= (before[before.length - 1]?.end ?? d.start));
      const cut = before.length && after.length ? cutBetween(before[before.length - 1]!, after[0]!, fps) : quantizeToFrame(turn, fps, "floor");
      if (cut - d.start >= input.minRunFlicks && d.end - cut >= input.minRunFlicks) {
        gated.push({ ...d, end: cut, words: wordsIn(d.words, d.start, cut), reasons: [...d.reasons, head.why] });
        gated.push({ ...d, start: cut, words: wordsIn(d.words, cut, d.end), layout: "lt-full-visual", role: d.role === "outro" ? "outro" : "body", reasons: ["presenter turns away mid-line → full visual for the remainder"], exceptions: [] });
        continue;
      }
    }
    gated.push({ ...d, layout: "lt-full-visual", reasons: [...d.reasons, `camera withheld: ${whole.why} → full visual`], exceptions: [`${d.lineIds.join("+")}: ${d.reasons[0]} overridden — ${whole.why}`] });
  }
  drafts = gated;

  // 3. Merge consecutive identical layouts when the result stays within the run limit
  //    (never into the hook, whose end is the hook → first-point join).
  const merged: Draft[] = [];
  for (const d of drafts) {
    const prev = merged[merged.length - 1];
    if (prev && prev.layout === d.layout && prev.role !== "hook" && d.role !== "hook" && d.end - prev.start <= input.maxRunFlicks) {
      merged[merged.length - 1] = { ...prev, end: d.end, role: d.role === "outro" ? "outro" : prev.role, lineIds: [...new Set([...prev.lineIds, ...d.lineIds])], words: [...prev.words, ...d.words], reasons: [...prev.reasons, ...d.reasons.filter((r) => !prev.reasons.includes(r))], exceptions: [...prev.exceptions, ...d.exceptions] };
    } else merged.push(d);
  }
  drafts = merged;

  // 4. Split runs longer than the limit at the best word boundary, alternating the layout.
  for (let guard = 0; guard < 64; guard++) {
    const i = drafts.findIndex((d) => d.end - d.start > input.maxRunFlicks * 1.0625);
    if (i < 0) break;
    const d = drafts[i]!;
    const cut = bestSplit(d, Math.round((d.start + d.end) / 2), fps, input.minRunFlicks);
    if (cut === null) {
      d.exceptions.push(`run ${((d.end - d.start) / 705_600_000).toFixed(1)} s exceeds ~${(input.maxRunFlicks / 705_600_000).toFixed(0)} s — no usable word boundary`);
      break;
    }
    const tailCamera = cameraOk(cut, d.end).ok;
    const head: Draft = { ...d, end: cut, words: wordsIn(d.words, d.start, cut), role: d.role === "outro" ? "body" : d.role };
    let tailLayout = alternate(d.layout, tailCamera);
    const next = drafts[i + 1];
    if (next && next.layout === tailLayout && tailLayout !== d.layout) tailLayout = d.layout;
    const tail: Draft = { ...d, start: cut, words: wordsIn(d.words, cut, d.end), layout: tailLayout, role: d.role === "hook" ? "body" : d.role, reasons: [`split from a ${((d.end - d.start) / 705_600_000).toFixed(1)} s run (limit ~${(input.maxRunFlicks / 705_600_000).toFixed(0)} s) → ${tailLayout.replace("lt-", "")}`], exceptions: [] };
    drafts.splice(i, 1, head, tail);
  }

  // 5. Absorb runs too short to read as a layout of their own.
  for (let guard = 0; guard < 64; guard++) {
    const i = drafts.findIndex((d) => d.end - d.start < input.minRunFlicks);
    if (i < 0 || drafts.length === 1) break;
    const d = drafts[i]!;
    const prev = drafts[i - 1];
    const next = drafts[i + 1];
    const into = prev && (!next || prev.layout === d.layout || next.role === "outro") ? i - 1 : i + 1;
    const t = drafts[into]!;
    const a = Math.min(t.start, d.start);
    const b = Math.max(t.end, d.end);
    drafts.splice(Math.min(i, into), 2, { ...t, start: a, end: b, lineIds: [...new Set(into < i ? [...t.lineIds, ...d.lineIds] : [...d.lineIds, ...t.lineIds])], words: into < i ? [...t.words, ...d.words] : [...d.words, ...t.words], reasons: [...t.reasons, `absorbed a ${((d.end - d.start) / 705_600).toFixed(0)} ms fragment`], exceptions: [...t.exceptions, ...d.exceptions] });
  }

  // 6. Use all three layouts when the material supports it.
  const used = new Set(drafts.map((d) => d.layout));
  for (const missing of (["lt-split", "lt-full-visual", "lt-full-camera"] as LtLayout[]).filter((l) => !used.has(l))) {
    const candidate = drafts.findIndex((d, i) => {
      if (d.role === "hook" && missing !== "lt-split") return false;
      if (d.role === "outro") return false;
      if (CAMERA_LAYOUTS.has(missing) && !cameraOk(d.start, d.end).ok) return false;
      const neighbours = [drafts[i - 1]?.layout, drafts[i + 1]?.layout];
      if (neighbours.includes(missing)) return false;
      return drafts.filter((x) => x.layout === d.layout).length > 1;
    });
    if (candidate >= 0) {
      const d = drafts[candidate]!;
      drafts[candidate] = { ...d, layout: missing, reasons: [...d.reasons, `→ ${missing.replace("lt-", "")} so the edit uses all three layouts`] };
      used.add(missing);
    } else exceptions.push(`layout ${missing.replace("lt-", "")} not used: no run where it fits (${CAMERA_LAYOUTS.has(missing) ? "eye contact / roles / neighbours" : "roles / neighbours"})`);
  }

  // 7. Record what could not be satisfied.
  for (let i = 1; i < drafts.length; i++) {
    if (drafts[i]!.layout === drafts[i - 1]!.layout) exceptions.push(`consecutive ${drafts[i]!.layout.replace("lt-", "")} runs at ${(drafts[i]!.start / 705_600_000).toFixed(2)} s (merge would exceed the run limit or cross the hook join)`);
  }
  for (const d of drafts) exceptions.push(...d.exceptions);

  drafts[0]!.start = 0;
  drafts[drafts.length - 1]!.end = input.end;
  for (let i = 1; i < drafts.length; i++) {
    if (drafts[i]!.start !== drafts[i - 1]!.end) throw new Error(`planLuxuryLayout: runs do not tile at ${drafts[i]!.start}`);
  }
  return {
    runs: drafts.map((d) => ({ start: d.start, end: d.end, layout: d.layout, role: d.role, lineIds: d.lineIds, wordIds: d.words.map((w) => w.id), reason: d.reasons.join("; "), exceptions: d.exceptions })),
    exceptions,
  };
}

/** Caption zone per run; the outro zone only applies when a CTA occupies the lower canvas. */
export function luxuryCaptionZone(zones: Record<string, { y0: number; y1: number }>, layout: LtLayout, opts: { outroWithCta?: boolean; lowContent?: boolean } = {}): { y0: number; y1: number } {
  if (layout === "lt-full-camera" && opts.outroWithCta && zones.outro) return zones.outro;
  if (layout === "lt-full-visual" && opts.lowContent && zones["lt-full-visual-low-content"]) return zones["lt-full-visual-low-content"];
  const z = zones[layout];
  if (!z) throw new Error(`no caption zone for ${layout}`);
  return z;
}

/** Gaze evidence from per-output-time samples (boolean at-lens votes with confidence). */
export function gazeFromSamples(samples: Array<{ t: Flicks; atLens: boolean; confidence: number }>, minAwayFlicks: Flicks): GazeEvidence {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  return {
    atLens(a, b) {
      const s = sorted.filter((x) => x.t >= a && x.t < b);
      if (s.length === 0) return { fraction: null, samples: 0 };
      const w = s.reduce((acc, x) => acc + x.confidence, 0);
      const yes = s.reduce((acc, x) => acc + (x.atLens ? x.confidence : 0), 0);
      return { fraction: w > 0 ? yes / w : 0, samples: s.length };
    },
    turnAway(a, b) {
      const s = sorted.filter((x) => x.t >= a && x.t < b);
      let awayStart: Flicks | null = null;
      for (const x of s) {
        if (!x.atLens) {
          awayStart ??= x.t;
          if (x.t - awayStart >= minAwayFlicks) return awayStart;
        } else awayStart = null;
      }
      return awayStart !== null && b - awayStart >= minAwayFlicks ? awayStart : null;
    },
  };
}
