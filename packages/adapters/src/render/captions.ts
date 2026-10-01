import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  flicksPerFrame,
  type CaptionChunk,
  type CaptionStyle,
  type CaptionTrack,
  type Flicks,
  type Rational,
  type TextTreatment,
} from "../../../core/src/index.ts";
import { paths } from "../env.ts";
import { gsapScript } from "../hyperframes.ts";

/** One distinct visual caption state = one rendered frame of the state sheet. */
export interface CaptionState {
  index: number;
  chunkId: string;
  activeWordId: string | null;
  zone: { y0: number; y1: number };
}

/** Per output frame: which state to show and the entrance/exit transform to apply. */
export interface CaptionFrame {
  state: number;
  scale: number;
  dy: number;
  opacity: number;
}

export interface CaptionPlan {
  states: CaptionState[];
  /** Run-length encoded frame list: [startFrame, endFrame) → frame. */
  runs: Array<{ start: number; end: number; frame: CaptionFrame }>;
  frameCount: number;
  fps: Rational;
}

function easeOutCubic(p: number): number {
  return 1 - (1 - p) ** 3;
}

function easeOutBack(p: number, s = 1.6): number {
  const q = p - 1;
  return 1 + (s + 1) * q ** 3 + s * q ** 2;
}

/** Entrance transform at progress p (0 < p <= 1). */
function enterTransform(kind: CaptionStyle["animation"]["enter"], p: number, intensity: number): Omit<CaptionFrame, "state"> {
  switch (kind) {
    case "pop":
      return { scale: 1 - 0.16 * intensity * (1 - easeOutBack(p)), dy: 0, opacity: Math.min(1, p * 2) };
    case "rise":
    case "slide":
      return { scale: 1, dy: Math.round(22 * intensity * (1 - easeOutCubic(p))), opacity: easeOutCubic(p) };
    case "fade":
      return { scale: 1, dy: 0, opacity: easeOutCubic(p) };
    default:
      return { scale: 1, dy: 0, opacity: 1 };
  }
}

/**
 * Builds the state list and the frame-exact schedule for a caption track.
 * Chunk boundaries come straight from the EditPlan (already frame-aligned).
 */
export function planCaptionStates(
  track: CaptionTrack,
  style: CaptionStyle,
  zoneFor: (chunk: CaptionChunk) => { y0: number; y1: number },
  fps: Rational,
  frameCount: number,
): CaptionPlan {
  const frame = flicksPerFrame(fps);
  const states: CaptionState[] = [];
  const runs: CaptionPlan["runs"] = [];
  const fpsNum = fps.num / fps.den;
  const enterFrames = style.animation.enter === "none" || style.animation.intensity === 0 ? 0 : Math.max(1, Math.round((style.animation.durationMs / 1000) * fpsNum));
  const exitFrames = style.animation.exit === "fade" ? Math.max(1, Math.round(0.12 * fpsNum)) : 0;
  const karaoke = style.emphasis.mode === "current-word";

  const stateKey = new Map<string, number>();
  const addState = (chunk: CaptionChunk, activeWordId: string | null): number => {
    const key = `${chunk.id}|${activeWordId ?? ""}`;
    const existing = stateKey.get(key);
    if (existing !== undefined) return existing;
    const idx = states.length;
    states.push({ index: idx, chunkId: chunk.id, activeWordId, zone: chunk.zoneOverride ? { y0: chunk.zoneOverride.y0, y1: chunk.zoneOverride.y1 } : zoneFor(chunk) });
    stateKey.set(key, idx);
    return idx;
  };

  const push = (start: number, end: number, f: CaptionFrame) => {
    if (end <= start) return;
    const last = runs[runs.length - 1];
    if (last && last.end === start && JSON.stringify(last.frame) === JSON.stringify(f)) last.end = end;
    else runs.push({ start, end, frame: f });
  };

  for (const chunk of track.chunks) {
    const a = Math.round(chunk.outStart / frame);
    const b = Math.min(frameCount, Math.round(chunk.outEnd / frame));
    if (b <= a) continue;
    const n = Math.min(enterFrames, Math.max(0, b - a - 1));
    const ex = Math.min(exitFrames, Math.max(0, b - a - n - 1));
    for (let k = a; k < b; k++) {
      const tFlicks: Flicks = k * frame;
      let active: string | null = null;
      if (karaoke) {
        for (const w of chunk.words) if (w.outStart <= tFlicks + frame / 2) active = w.id;
        active = active ?? chunk.words[0]!.id;
      }
      const state = addState(chunk, active);
      let tf: Omit<CaptionFrame, "state"> = { scale: 1, dy: 0, opacity: 1 };
      if (k - a < n) tf = enterTransform(style.animation.enter, (k - a + 1) / (n + 1), style.animation.intensity);
      else if (ex > 0 && k >= b - ex) tf = { scale: 1, dy: 0, opacity: (b - k) / (ex + 1) };
      push(k, k + 1, { state, scale: Number(tf.scale.toFixed(4)), dy: tf.dy, opacity: Number(tf.opacity.toFixed(4)) });
    }
  }
  return { states, runs, frameCount, fps };
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function treatmentCss(t: Partial<TextTreatment> & { lineHeight?: number; letterSpacingEm?: number }, familyAlias: (f: string) => string): string {
  const css: string[] = [];
  if (t.family) css.push(`font-family: "${familyAlias(t.family)}", sans-serif;`);
  if (t.weight !== undefined) css.push(`font-weight: ${t.weight};`);
  if (t.style) css.push(`font-style: ${t.style};`);
  if (t.sizePx !== undefined) css.push(`font-size: ${t.sizePx}px;`);
  if (t.color) css.push(`color: ${t.color};`);
  if (t.lineHeight !== undefined) css.push(`line-height: ${t.lineHeight};`);
  if (t.letterSpacingEm !== undefined) css.push(`letter-spacing: ${t.letterSpacingEm}em;`);
  if (t.stroke !== undefined) {
    if (t.stroke && t.stroke.widthPx > 0) css.push(`-webkit-text-stroke: ${t.stroke.widthPx * 2}px ${t.stroke.color};`, "paint-order: stroke fill;");
    else css.push("-webkit-text-stroke: 0;");
  }
  if (t.shadow !== undefined) css.push(`text-shadow: ${t.shadow ?? "none"};`);
  if (t.box) {
    css.push(
      `background: ${t.box.color};`,
      `border-radius: ${t.box.radiusPx}px;`,
      `padding: ${t.box.padY}px ${t.box.padX}px;`,
      `margin: 0 -${t.box.padX}px;`,
      "-webkit-box-decoration-break: clone;",
      "box-decoration-break: clone;",
    );
  }
  if (t.scale !== undefined && t.scale !== 1) css.push("display: inline-block;", `transform: scale(${t.scale});`);
  return css.join(" ");
}

/** Extra word spacing that keeps stroked words visually separate (also used by text measurement). */
export function wordSpacingPx(style: CaptionStyle): number {
  return Math.round(style.base.stroke?.widthPx ?? 0);
}

export interface CaptionComposition {
  dir: string;
  stateCount: number;
  fps: number;
}

/**
 * Writes a HyperFrames project that renders each caption state as one frame.
 * Fonts and GSAP are copied locally so the render never touches the network.
 */
export function writeCaptionComposition(dir: string, plan: CaptionPlan, track: CaptionTrack, style: CaptionStyle, canvas: { width: number; height: number }): CaptionComposition {
  const p = paths();
  const assets = join(dir, "assets");
  mkdirSync(join(assets, "fonts"), { recursive: true });
  const gsap = gsapScript();
  if (!gsap) throw new Error("gsap is not installed in the runtime; run `shorts-studio doctor --setup`");
  copyFileSync(gsap, join(assets, "gsap.min.js"));

  const alias = (family: string) => `SS ${family}`;
  const faces = style.fonts.map((f) => {
    const src = join(p.fontsDir, f.file);
    if (!existsSync(src)) throw new Error(`font file missing: ${src}`);
    copyFileSync(src, join(assets, "fonts", basename(f.file)));
    const variable = /Variable/.test(f.file);
    return `      @font-face {\n        font-family: "${alias(f.family)}";\n        src: url("assets/fonts/${basename(f.file)}");\n        font-weight: ${variable ? "100 900" : f.weight};\n        font-style: ${f.style};\n        font-display: block;\n      }`;
  });

  const base = style.base;
  const css = [
    `      .ln, .w { ${treatmentCss({ family: base.family, weight: base.weight, style: base.style, sizePx: base.sizePx, color: base.color, lineHeight: base.lineHeight, letterSpacingEm: base.letterSpacingEm }, alias)} font-synthesis: none; }`,
    // Outer strokes eat into inter-word gaps; widen spaces by the visible stroke width.
    `      .ln { word-spacing: ${wordSpacingPx(style)}px; }`,
    `      .w { ${treatmentCss({ stroke: base.stroke, shadow: base.shadow, box: base.box }, alias)} }`,
    `      .w.em { ${treatmentCss(style.emphasis.treatment, alias)} }`,
    `      .w.act { ${treatmentCss(style.emphasis.treatment, alias)} }`,
  ].join("\n");

  const chunkById = new Map(track.chunks.map((c) => [c.id, c]));
  const stateHtml = plan.states.map((s) => {
    const chunk = chunkById.get(s.chunkId)!;
    const byId = new Map(chunk.words.map((w) => [w.id, w]));
    const lines = chunk.lines
      .map((ids) => {
        const words = ids
          .map((id) => {
            const w = byId.get(id)!;
            const cls = ["w"];
            if (w.emphasis === "highlight" && style.emphasis.mode !== "current-word") cls.push("em");
            if (s.activeWordId === w.id) cls.push("act");
            return `<span class="${cls.join(" ")}">${esc(w.display)}</span>`;
          })
          .join(" ");
        return `<span class="ln">${words}</span>`;
      })
      .join("");
    const top = Math.round(s.zone.y0);
    const height = Math.max(1, Math.round(s.zone.y1 - s.zone.y0));
    return `      <div class="st" id="s${s.index}" data-chunk="${s.chunkId}" style="top: ${top}px; height: ${height}px"><div class="blk">${lines}</div></div>`;
  });

  const fps = 10;
  const tpl = readFileSync(join(p.templatesDir, "hyperframes", "caption-states", "template.html"), "utf8");
  const html = tpl
    .replaceAll("{{LANG}}", esc(track.language))
    .replaceAll("{{W}}", String(canvas.width))
    .replaceAll("{{H}}", String(canvas.height))
    .replaceAll("{{STYLE_ID}}", esc(style.id))
    .replaceAll("{{FPS}}", String(fps))
    .replaceAll("{{COUNT}}", String(plan.states.length))
    .replaceAll("{{DURATION}}", (Math.max(1, plan.states.length) / fps).toFixed(3))
    .replaceAll("{{MAX_W}}", String(style.placement.maxWidthPx))
    .replaceAll("{{ALIGN}}", style.placement.align)
    .replaceAll("{{FONT_FACES}}", faces.join("\n"))
    .replaceAll("{{STYLE_CSS}}", css)
    .replaceAll("{{STATES}}", stateHtml.join("\n"));
  writeFileSync(join(dir, "index.html"), html);
  writeFileSync(join(dir, "states.json"), JSON.stringify({ fps, states: plan.states }, null, 1));
  return { dir, stateCount: plan.states.length, fps };
}
