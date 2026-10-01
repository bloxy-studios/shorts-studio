/**
 * Luxury Tech graphics → one HyperFrames composition per layout run.
 *
 * The world camera is sampled per frame (core/luxury/camera.ts) and written as
 * timeline sets, so motion and its velocity blur share one path and every seek is
 * deterministic. Item actions are GSAP tweens/sets on the same paused timeline.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { measureText, type MetricsTable } from "../../../core/src/index.ts";
import { sampleCamera, type CameraFrame } from "../../../core/src/luxury/camera.ts";
import type { CompiledAction, CompiledGraphic, Item } from "../../../core/src/luxury/graphics.ts";
import { paths } from "../env.ts";
import { gsapScript } from "../hyperframes.ts";
import { iconSvg } from "./luxury-icons.ts";

export interface LuxuryCompositionOptions {
  fps: number;
  frames: number;
  /** Split layout: draw the camera card's shadow plate and fade the world below y=900. */
  split: boolean;
  cover: { title: string } | null;
  motionBlur: { enabled: boolean; shutter: number; maxSigma: number };
  /** >1 renders sub-frames (e.g. 4 → 240 fps) for temporal integration; velocity blur is then off. */
  subframes: number;
  metrics: MetricsTable;
}

export interface LuxuryComposition {
  dir: string;
  durationS: number;
  renderFps: number;
  blurFrames: number;
  peakSigma: number;
  landingSharp: boolean;
  coverLines: string[];
}

const SHADOW = "0 60px 120px rgba(24,24,32,.16), 0 24px 48px rgba(24,24,32,.10), 0 4px 10px rgba(24,24,32,.06)";
const TONE: Record<string, string> = { ink: "#111111", clay: "#D97757", check: "#34C759", stamp: "#FF3B30" };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function px(n: number): string {
  return `${Math.round(n * 100) / 100}px`;
}

/** Greedy wrap with measured Poppins advances; returns null when it needs more than maxLines. */
function wrap(metrics: MetricsTable, text: string, weight: number, sizePx: number, maxW: number, maxLines: number): string[] | null {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (measureText(metrics, { family: "Poppins", weight, style: "normal", sizePx }, next) <= maxW || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  const widest = Math.max(...lines.map((l) => measureText(metrics, { family: "Poppins", weight, style: "normal", sizePx }, l)));
  return lines.length <= maxLines && widest <= maxW ? lines : null;
}

/** Largest size from `sizes` whose wrap fits; rebalanced only to avoid an orphaned last line. */
function fitText(metrics: MetricsTable, text: string, weight: number, sizes: number[], maxW: number, maxLines: number, maxH: number, lineHeight: number): { size: number; lines: string[] } {
  const width = (l: string, size: number) => measureText(metrics, { family: "Poppins", weight, style: "normal", sizePx: size }, l);
  for (const size of sizes) {
    let lines = wrap(metrics, text, weight, size, maxW, maxLines);
    if (!lines || lines.length * size * lineHeight > maxH) continue;
    if (lines.length > 1) {
      const widest = Math.max(...lines.map((l) => width(l, size)));
      if (width(lines[lines.length - 1]!, size) < widest * 0.5) {
        // Pull words down from earlier lines, never narrowing the block below 75% of the measure.
        for (let w = maxW - 20; w >= maxW * 0.75; w -= 20) {
          const alt = wrap(metrics, text, weight, size, w, lines.length);
          if (!alt || alt.length > lines.length) break;
          lines = alt;
          if (width(lines[lines.length - 1]!, size) >= Math.max(...lines.map((l) => width(l, size))) * 0.5) break;
        }
      }
    }
    return { size, lines };
  }
  const size = sizes[sizes.length - 1]!;
  return { size, lines: wrap(metrics, text, weight, size, maxW, 99) ?? [text] };
}

function linesHtml(lines: string[]): string {
  return lines.map((l) => `<span>${esc(l)}</span>`).join("");
}

function box(it: Item, extra = ""): string {
  return `left:${px(it.x)};top:${px(it.y)};width:${px(it.w)};height:${px(it.h)};${extra}`;
}

function itemHtml(it: Item, m: MetricsTable, assets: string): string {
  const id = `i-${it.id}`;
  switch (it.kind) {
    case "card": {
      const pad = 64;
      const innerW = it.w - 2 * pad;
      const iconH = it.icon ? 136 + 26 : 0;
      const eyebrowH = it.eyebrow ? 30 + 22 : 0;
      const bodyFit = it.body ? fitText(m, it.body, 400, [34, 32, 30], innerW, 4, 200, 1.35) : null;
      const bodyH = bodyFit ? bodyFit.lines.length * bodyFit.size * 1.35 + 22 : 0;
      const titleFit = it.title ? fitText(m, it.title, 700, [96, 88, 80, 72, 64, 56, 52], innerW, 3, it.h - 2 * pad - iconH - eyebrowH - bodyH, 1.04) : null;
      return `<div class="it card" id="${id}" style="${box(it)}"><div class="inner pad${it.align === "center" ? " center" : ""}">${it.icon ? `<div class="badge" style="color:${TONE[it.iconTone]}">${iconSvg(it.icon, 84, 1.7)}</div>` : ""}${it.eyebrow ? `<div class="eyebrow">${esc(it.eyebrow)}</div>` : ""}${titleFit ? `<div class="title" style="font-size:${titleFit.size}px">${linesHtml(titleFit.lines)}</div>` : ""}${bodyFit ? `<div class="body" style="font-size:${bodyFit.size}px">${linesHtml(bodyFit.lines)}</div>` : ""}</div></div>`;
    }
    case "stat": {
      const v = fitText(m, it.value, 700, [200, 168, 140, 120, 96], it.w - 112, 1, it.h * 0.6, 1);
      const l = fitText(m, it.label, 600, [40, 36, 32, 30], it.w - 112, 2, 110, 1.25);
      return `<div class="it stat" id="${id}" style="${box(it)}"><div class="inner pad center">${it.icon ? `<div class="badge">${iconSvg(it.icon, 84, 1.7)}</div>` : ""}<div class="value" style="font-size:${v.size}px">${esc(it.value)}</div><div class="label" style="font-size:${l.size}px">${linesHtml(l.lines)}</div></div></div>`;
    }
    case "list": {
      // Typography scales with the card: the largest title/row pair that fills it comfortably.
      const innerH = it.h - 128;
      let best: { title: { size: number; lines: string[] } | null; rows: Array<{ size: number; lines: string[] }>; row: number } | null = null;
      for (const row of [56, 52, 48, 44, 40, 36, 32]) {
        const titleSizes = [96, 88, 80, 72, 64, 56, 52].filter((s2) => s2 >= row * 1.3);
        const title = it.title ? fitText(m, it.title, 700, titleSizes.length ? titleSizes : [row * 1.3], it.w - 128, 2, innerH * 0.45, 1.08) : null;
        const markW = Math.round(row * 1.5);
        const rows = it.rows.map((r) => fitText(m, r.text, 600, [row], it.w - 128 - markW - 28, 2, row * 2.6, 1.2));
        const gap = Math.round(row * 0.6);
        const h = (title ? title.lines.length * title.size * 1.08 + gap * 1.2 : 0) + rows.reduce((acc, r) => acc + Math.max(markW, r.lines.length * r.size * 1.2), 0) + gap * (rows.length - 1);
        if (h <= innerH * 0.92 && rows.every((r) => r.size === row)) {
          best = { title, rows, row };
          break;
        }
      }
      best ??= { title: it.title ? fitText(m, it.title, 700, [52], it.w - 128, 2, innerH * 0.45, 1.08) : null, rows: it.rows.map((r) => fitText(m, r.text, 600, [30], it.w - 216, 2, 80, 1.2)), row: 30 };
      const markW = Math.round(best.row * 1.5);
      const rows = it.rows
        .map((r, i) => {
          const t = best!.rows[i]!;
          const mark = r.mark === "check" ? iconSvg("check", Math.round(markW * 0.58), 3) : r.mark === "cross" ? iconSvg("cross", Math.round(markW * 0.5), 3) : "";
          return `<div class="row"><div class="slot" style="width:${markW}px;height:${markW}px;border-radius:${markW / 2}px"><div class="mark ${r.mark}" id="${id}-m${i}" style="border-radius:${markW / 2}px">${mark}</div></div><div class="rowtext" style="font-size:${t.size}px">${linesHtml(t.lines)}</div></div>`;
        })
        .join("");
      return `<div class="it list" id="${id}" style="${box(it)}"><div class="inner pad">${best.title ? `<div class="title" style="font-size:${best.title.size}px;margin-bottom:${Math.round(best.row * 0.3)}px">${linesHtml(best.title.lines)}</div>` : ""}<div class="rows" style="gap:${Math.round(best.row * 0.6)}px">${rows}</div></div></div>`;
    }
    case "tile": {
      const icon = Math.round(Math.min(it.w, it.h) * (it.label ? 0.38 : 0.5));
      const l = it.label ? fitText(m, it.label, 600, [44, 40, 36, 32, 30], it.w - 64, 2, 110, 1.15) : null;
      return `<div class="it tile" id="${id}" style="${box(it)}"><div class="inner tilein" style="color:${TONE[it.tone]}">${iconSvg(it.icon, icon, 1.6)}${l ? `<div class="label ink" style="font-size:${l.size}px">${linesHtml(l.lines)}</div>` : ""}</div></div>`;
    }
    case "code": {
      // Fill the window: the largest size (≤ 56 px) at which every line fits.
      const longest = it.lines.reduce((a, l) => (measureText(m, { family: "Poppins", weight: 500, style: "normal", sizePx: 100 }, l) > measureText(m, { family: "Poppins", weight: 500, style: "normal", sizePx: 100 }, a) ? l : a), "");
      const byW = ((it.w - 96) / Math.max(1, measureText(m, { family: "Poppins", weight: 500, style: "normal", sizePx: 100 }, longest))) * 100;
      const byH = (it.h - 84 - 88) / (it.lines.length * 1.6);
      const size = Math.max(30, Math.min(56, Math.floor(Math.min(byW, byH))));
      const chars = it.lines.map((line, li) => [...line].map((ch, k) => `<span class="ch" data-k="${li}-${k}">${esc(ch)}</span>`).join("")).join('<br/>');
      return `<div class="it window" id="${id}" style="${box(it)}"><div class="bar"><i></i><i></i><i></i><span class="app">${esc(it.title)}</span></div><div class="inner code" style="font-size:${size}px">${chars}<span class="caret" id="${id}-caret" style="height:${Math.round(size * 1.1)}px"></span></div></div>`;
    }
    case "chat": {
      // Phone-readable type that scales with the window (34–50 px).
      const t = Math.max(34, Math.min(50, Math.round((it.w / 900) * 44)));
      const typed = [...it.prompt].map((ch) => `<span class="ch">${esc(ch)}</span>`).join("");
      const words = it.response.split(/\s+/).map((w) => `<span class="wd">${esc(w)} </span>`).join("");
      return `<div class="it window" id="${id}" style="${box(it)}"><div class="bar"><i></i><i></i><i></i><span class="app">${esc(it.app)}</span></div><div class="inner thread" style="font-size:${t}px"><div class="bubble" id="${id}-bub" style="font-size:${t}px">${esc(it.prompt)}</div><div class="answer" id="${id}-ans" style="font-size:${t}px">${words}</div></div><div class="input" style="height:${Math.round(t * 2.3)}px;border-radius:${Math.round(t * 1.15)}px"><div class="field" id="${id}-field" style="font-size:${Math.round(t * 0.95)}px">${typed}<span class="caret" id="${id}-caret" style="height:${Math.round(t * 1.15)}px"></span></div><div class="sendbtn" id="${id}-send" style="width:${Math.round(t * 1.6)}px;height:${Math.round(t * 1.6)}px;border-radius:${Math.round(t * 0.8)}px">${iconSvg("send", Math.round(t * 0.8), 2.4)}</div></div></div>`;
    }
    case "document": {
      const t = fitText(m, it.title, 700, [56, 52, 48], it.w - 128, 2, 140, 1.1);
      const body = it.lines.map((l) => (l === "~" ? `<div class="bar-line"></div>` : `<div class="docline">${esc(l)}</div>`)).join("");
      const stampSize = Math.max(44, Math.min(84, Math.round(it.w * 0.085)));
      return `<div class="it doc" id="${id}" style="${box(it)}"><div class="inner pad top"><div class="title" style="font-size:${t.size}px">${linesHtml(t.lines)}</div>${body}</div>${it.stamp ? `<div class="stamp" id="${id}-stamp" style="font-size:${stampSize}px;border-width:${Math.round(stampSize / 8)}px;padding:${Math.round(stampSize * 0.3)}px ${Math.round(stampSize * 0.6)}px">${esc(it.stamp.text)}</div>` : ""}</div>`;
    }
    case "image": {
      if (!existsSync(it.src)) throw new Error(`image ${it.src} does not exist`);
      const name = `img-${it.id}${extname(it.src).toLowerCase()}`;
      copyFileSync(it.src, join(assets, name));
      const r = Math.round(it.w * 0.03);
      return `<div class="it media" id="${id}" style="${box(it, `border-radius:${r}px`)}"><div class="inner" style="border-radius:${r}px"><img src="assets/${name}" alt="" style="object-fit:${it.fit}"/></div>${it.caption ? `<div class="caption">${esc(it.caption)}</div>` : ""}</div>`;
    }
    case "radar": {
      const d = Math.min(it.w - 120, it.h - (it.label ? 200 : 120));
      const rings = [0.33, 0.66, 1].map((f) => `<circle cx="50" cy="50" r="${(49 * f).toFixed(2)}"/>`).join("");
      const blips = Array.from({ length: it.blips }, (_, i) => {
        const ang = ((i * 137.5 + 40) % 360) * (Math.PI / 180);
        const rr = 0.3 + ((i * 0.37) % 0.6);
        return `<div class="blip" id="${id}-b${i}" style="left:${(50 + Math.sin(ang) * rr * 48).toFixed(2)}%;top:${(50 - Math.cos(ang) * rr * 48).toFixed(2)}%"></div>`;
      }).join("");
      return `<div class="it radar" id="${id}" style="${box(it)}"><div class="inner"><div class="scope" style="width:${d}px;height:${d}px;left:${px((it.w - d) / 2)};top:${px(it.label ? 64 : (it.h - d) / 2)}"><svg viewBox="0 0 100 100" class="rings">${rings}<path d="M50 1v98M1 50h98"/></svg><div class="sweep" id="${id}-sweep"></div>${blips}<div class="hub"></div></div>${it.label ? `<div class="label ink radar-label">${esc(it.label)}</div>` : ""}</div></div>`;
    }
    case "text": {
      const sizes = it.size === "headline" ? [96, 88, 80, 72] : it.size === "subhead" ? [52, 48, 44] : [34, 32, 30];
      const weight = it.size === "body" ? 400 : 700;
      const f = fitText(m, it.text, weight, sizes, it.w, 3, it.h, 1.08);
      return `<div class="it text" id="${id}" style="${box(it, `text-align:${it.align};color:${TONE[it.tone]};font-weight:${weight};font-size:${f.size}px`)}">${linesHtml(f.lines)}</div>`;
    }
    case "connector":
    case "source-page":
      return "";
  }
}

/** Pixel size of a PNG or JPEG (captures), read from the header. */
export function imageSize(path: string): { w: number; h: number } {
  const b = readFileSync(path);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) break;
      const marker = b[o + 1]!;
      const len = b.readUInt16BE(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: b.readUInt16BE(o + 7), h: b.readUInt16BE(o + 5) };
      o += 2 + len;
    }
  }
  throw new Error(`cannot read the size of ${path} (PNG or JPEG expected)`);
}

/** Fixed source-page layer: washed blurred clone behind a sharp framed capture that pans inside. */
function sourcePageHtml(it: Extract<Item, { kind: "source-page" }>, assets: string): string {
  if (!existsSync(it.src)) throw new Error(`source page capture ${it.src} does not exist`);
  const name = `page-${it.id}${extname(it.src).toLowerCase()}`;
  copyFileSync(it.src, join(assets, name));
  const label = it.label ? `<div class="page-label" style="top:${px(it.y + it.h + 22)}">${esc(it.label)}</div>` : "";
  return `<div class="page-layer" id="i-${it.id}"><div class="page-backdrop"><img src="assets/${name}" alt=""/></div><div class="page-wash"></div><div class="page-frame" style="${box(it as Item)}"><img id="i-${it.id}-img" src="assets/${name}" alt="source page"/></div>${label}</div>`;
}

function connectorSvg(items: Item[]): string {
  const byId = new Map(items.map((i) => [i.id, i]));
  const paths_ = items
    .filter((i): i is Extract<Item, { kind: "connector" }> => i.kind === "connector")
    .map((c) => {
      const a = byId.get(c.from)!;
      const b = byId.get(c.to)!;
      const ax = a.x + a.w / 2;
      const ay = a.y + a.h / 2;
      const bx = b.x + b.w / 2;
      const by = b.y + b.h / 2;
      // Leave from / arrive at the facing edges.
      const horizontal = Math.abs(bx - ax) > Math.abs(by - ay);
      const sx = horizontal ? (bx > ax ? a.x + a.w + 18 : a.x - 18) : ax;
      const sy = horizontal ? ay : by > ay ? a.y + a.h + 18 : a.y - 18;
      const ex = horizontal ? (bx > ax ? b.x - 26 : b.x + b.w + 26) : bx;
      const ey = horizontal ? by : by > ay ? b.y - 26 : b.y + b.h + 26;
      const mx = (sx + ex) / 2;
      const my = (sy + ey) / 2;
      const d = horizontal ? `M${sx},${sy} C${mx},${sy} ${mx},${ey} ${ex},${ey}` : `M${sx},${sy} C${sx},${my} ${ex},${my} ${ex},${ey}`;
      const ang = horizontal ? (bx > ax ? 0 : 180) : by > ay ? 90 : -90;
      return `<g id="i-${c.id}"><path class="wire" d="${d}" pathLength="1"/><path class="head" d="M-14,-11 L0,0 L-14,11" transform="translate(${ex},${ey}) rotate(${ang})"/></g>`;
    })
    .join("");
  return paths_ ? `<svg class="wires" width="1080" height="1920" viewBox="0 0 1080 1920" style="overflow:visible">${paths_}</svg>` : "";
}

function coverHtml(m: MetricsTable, title: string): { html: string; lines: string[] } {
  // Poppins 700 ~110 px, black on a white rounded box, ~50 px side padding, inside y 262–603.
  const f = fitText(m, title, 700, [110, 104, 98, 92, 86], 1000 - 100, 2, 603 - 262 - 56, 1.02);
  const h = Math.round(f.lines.length * f.size * 1.02 + 56);
  const top = Math.round(262 + (603 - 262 - h) / 2);
  return { html: `<div id="cover" style="top:${top}px;font-size:${f.size}px">${linesHtml(f.lines)}</div>`, lines: f.lines };
}

function actionJs(a: CompiledAction, g: CompiledGraphic, prevFocus: { id: string | null }): string {
  const sel = `"#i-${a.target}"`;
  const t = a.t.toFixed(4);
  switch (a.kind) {
    case "enter":
      // Connectors draw their wire instead (see the dash-offset tweens).
      if (g.items.find((i) => i.id === a.target)?.kind === "connector") return "";
      return `tl.fromTo(${sel}, { autoAlpha: 0, y: 44, scale: 0.965 }, { autoAlpha: 1, y: 0, scale: 1, duration: ${a.dur}, ease: "power3.out" }, ${t});`;
    case "mark":
      return `tl.fromTo("#i-${a.target}-m${a.index}", { autoAlpha: 0, scale: 0.55 }, { autoAlpha: 1, scale: 1, duration: ${a.dur}, ease: "power3.out" }, ${t});`;
    case "stamp":
      return `tl.fromTo("#i-${a.target}-stamp", { autoAlpha: 0, scale: 1.32, rotation: -8 }, { autoAlpha: 1, scale: 1, rotation: -8, duration: ${a.dur}, ease: "power3.out" }, ${t});`;
    case "type": {
      const it = g.items.find((i) => i.id === a.target)!;
      const n = it.kind === "chat" ? it.prompt.length : it.kind === "code" ? it.lines.join("").length : 0;
      return `typeChars("#i-${a.target}", ${n}, ${t}, ${a.dur.toFixed(4)});`;
    }
    case "send":
      return `press("#i-${a.target}-send", ${t}); tl.set("#i-${a.target}-field .ch", { display: "none" }, ${(a.t + 0.12).toFixed(4)}); tl.set("#i-${a.target}-caret", { autoAlpha: 0 }, ${(a.t + 0.12).toFixed(4)}); tl.fromTo("#i-${a.target}-bub", { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: 0.32, ease: "power3.out" }, ${(a.t + 0.1).toFixed(4)});`;
    case "response":
      return `streamWords("#i-${a.target}-ans .wd", ${t}, ${a.dur.toFixed(4)});`;
    case "click":
      return `press(${sel}, ${t});`;
    case "inner-zoom":
      return `tl.to("#i-${a.target} .inner", { scale: ${a.scale}, transformOrigin: "${((a.origin?.x ?? 0.5) * 100).toFixed(1)}% ${((a.origin?.y ?? 0.5) * 100).toFixed(1)}%", duration: ${a.dur}, ease: "power2.inOut" }, ${t});`;
    case "page-pan": {
      // Pan inside the fixed frame: `y` (0..1) of the capture's scrollable height, computed from its pixel size.
      const it = g.items.find((i) => i.id === a.target) as Extract<Item, { kind: "source-page" }>;
      const size = imageSize(it.src);
      const travel = Math.max(0, (it.w * size.h) / size.w - it.h);
      return `tl.to("#i-${a.target}-img", { y: ${(-travel * (a.y ?? 0)).toFixed(1)}, scale: ${(a.scale ?? 1).toFixed(3)}, duration: ${a.dur.toFixed(3)}, ease: "power2.inOut" }, ${t});`;
    }
    case "focus": {
      const others = g.items.filter((i) => i.id !== a.target && i.kind !== "connector").map((i) => `"#i-${i.id}"`);
      const lines = [`tl.to(${sel}, { filter: "blur(0px)", opacity: 1, duration: ${a.dur}, ease: "power2.inOut" }, ${t});`];
      for (const o of others) {
        const recede = prevFocus.id && o === `"#i-${prevFocus.id}"`;
        lines.push(`tl.to(${o}, { filter: "blur(${recede ? 9 : 14}px)", opacity: ${recede ? 0.4 : 0.7}, duration: ${a.dur}, ease: "power2.inOut" }, ${t});`);
      }
      prevFocus.id = a.target;
      return lines.join("\n      ");
    }
  }
}

const CSS = `
      :root { --ink:#111111; --muted:#5C5C63; --hair:#E7E7E2; --clay:#D97757; --clayText:#B25730; --band:#FBEEE8; --check:#34C759; --stamp:#FF3B30; --shadow:${SHADOW}; }
      html, body { margin:0; padding:0; background:#F3F3F0; }
      #root { position:relative; width:1080px; height:1920px; overflow:hidden; font-family:"Poppins"; color:var(--ink); -webkit-font-smoothing:antialiased;
        background: radial-gradient(ellipse 62% 48% at 50% 36%, #FFFFFF 0%, #FBFBF9 38%, #F3F3F0 100%); }
      #lens { position:absolute; left:0; top:0; width:1080px; height:1920px; }
      #world { position:absolute; left:0; top:0; width:1080px; height:1920px; transform-origin:0 0; }
      .it { position:absolute; box-sizing:border-box; }
      .card, .list, .doc, .stat, .radar, .tile, .window, .media { background:#FFFFFF; box-shadow:var(--shadow); }
      .card, .list, .doc, .stat, .radar { border-radius:40px; }
      .tile { border-radius:72px; }
      .window { border-radius:36px; overflow:hidden; }
      .media { overflow:visible; }
      .media .inner { position:absolute; inset:0; overflow:hidden; }
      .media img { width:100%; height:100%; display:block; }
      .media .caption { position:absolute; left:0; right:0; top:calc(100% + 26px); text-align:center; font:500 30px/1.3 "Poppins"; color:var(--muted); }
      .inner { position:absolute; inset:0; }
      .pad { inset:64px; display:flex; flex-direction:column; justify-content:center; gap:22px; }
      .pad.top { justify-content:flex-start; }
      .center { align-items:center; text-align:center; }
      .eyebrow { font:600 30px/1 "Poppins"; letter-spacing:.14em; text-transform:uppercase; color:var(--clayText); }
      .title { font-weight:700; letter-spacing:-0.025em; line-height:1.04; color:var(--ink); }
      .title span, .body span, .label span, .rowtext span, .text span, #cover span { display:block; white-space:nowrap; }
      .body { font-weight:400; line-height:1.35; color:var(--muted); }
      .badge { width:136px; height:136px; border-radius:40px; background:var(--band); color:var(--clay); display:flex; align-items:center; justify-content:center; flex:none; }
      .value { font-weight:700; letter-spacing:-0.04em; line-height:1; color:var(--ink); }
      .label { font-weight:600; line-height:1.2; color:var(--muted); }
      .label.ink { color:var(--ink); }
      .rows { display:flex; flex-direction:column; gap:26px; margin-top:12px; }
      .row { display:flex; align-items:center; gap:28px; }
      .slot { width:60px; height:60px; border-radius:30px; box-shadow: inset 0 0 0 3px var(--hair); flex:none; position:relative; }
      .mark { position:absolute; inset:0; border-radius:30px; display:flex; align-items:center; justify-content:center; color:#FFFFFF; }
      .mark.check { background:var(--check); }
      .mark.cross { background:var(--stamp); }
      .mark.dot { background:transparent; }
      .mark.dot::after { content:""; width:20px; height:20px; border-radius:10px; background:var(--clay); }
      .rowtext { font-weight:600; line-height:1.2; color:var(--ink); }
      .tilein { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:26px; text-align:center; }
      .bar { height:84px; display:flex; align-items:center; gap:14px; padding:0 34px; border-bottom:2px solid var(--hair); }
      .bar i { width:18px; height:18px; border-radius:9px; background:#E4E4DF; display:block; }
      .bar .app { margin-left:18px; font:600 30px/1 "Poppins"; color:var(--muted); }
      .code { top:84px; padding:44px 48px; font:500 34px/1.6 "Poppins"; color:var(--ink); white-space:pre; }
      .thread { top:84px; bottom:170px; padding:44px 48px; display:flex; flex-direction:column; gap:30px; }
      .bubble { align-self:flex-end; max-width:78%; background:var(--band); color:var(--ink); border-radius:34px 34px 10px 34px; padding:24px 32px; font:500 34px/1.35 "Poppins"; }
      .answer { font:400 34px/1.45 "Poppins"; color:var(--ink); }
      .input { position:absolute; left:34px; right:34px; bottom:34px; height:96px; border-radius:48px; box-shadow: inset 0 0 0 2px var(--hair); display:flex; align-items:center; padding:0 18px 0 36px; }
      .field { flex:1; font:500 32px/1 "Poppins"; color:var(--ink); white-space:nowrap; overflow:hidden; }
      .sendbtn { width:64px; height:64px; border-radius:32px; background:var(--clay); color:#fff; display:flex; align-items:center; justify-content:center; }
      .caret { display:inline-block; width:3px; height:38px; margin-left:3px; vertical-align:middle; background:var(--clay); }
      .doc .docline { font:400 32px/1.45 "Poppins"; color:var(--muted); }
      .doc .bar-line { height:18px; border-radius:9px; background:#EFEFEB; margin:10px 0; }
      .doc .bar-line:nth-child(odd) { width:82%; }
      .stamp { position:absolute; right:64px; bottom:72px; padding:14px 28px; border:6px solid var(--stamp); border-radius:20px; color:var(--stamp); font:700 44px/1 "Poppins"; letter-spacing:.06em; text-transform:uppercase; visibility:hidden; }
      .scope { position:absolute; border-radius:50%; background:#FCFCFA; box-shadow: inset 0 0 0 2px var(--hair); overflow:hidden; }
      .rings { position:absolute; inset:0; width:100%; height:100%; fill:none; stroke:#E6E6E1; stroke-width:.6; }
      .sweep { position:absolute; inset:0; border-radius:50%; background: conic-gradient(from 0deg, rgba(217,119,87,0) 0deg, rgba(217,119,87,0) 290deg, rgba(217,119,87,.10) 330deg, rgba(217,119,87,.42) 359deg, rgba(217,119,87,0) 360deg); }
      .blip { position:absolute; width:26px; height:26px; margin:-13px 0 0 -13px; border-radius:13px; background:var(--clay); box-shadow: 0 0 0 10px rgba(217,119,87,.16); visibility:hidden; }
      .hub { position:absolute; left:50%; top:50%; width:18px; height:18px; margin:-9px 0 0 -9px; border-radius:9px; background:var(--ink); }
      .radar-label { position:absolute; left:0; right:0; bottom:56px; text-align:center; font-size:40px; }
      .text { line-height:1.08; letter-spacing:-0.02em; }
      .wires { position:absolute; left:0; top:0; }
      .wire { fill:none; stroke:#CFCFC9; stroke-width:4; stroke-linecap:round; }
      .head { fill:none; stroke:#CFCFC9; stroke-width:4; stroke-linecap:round; stroke-linejoin:round; }
      .page-layer { position:absolute; inset:0; }
      .page-backdrop { position:absolute; inset:-80px; overflow:hidden; filter: blur(40px) saturate(.7) brightness(1.05); }
      .page-backdrop img { width:100%; height:100%; object-fit:cover; transform:scale(1.15); }
      .page-wash { position:absolute; inset:0; background:rgba(255,255,255,.72); }
      .page-frame { position:absolute; border-radius:36px; overflow:hidden; background:#FFFFFF; box-shadow:var(--shadow); }
      .page-frame img { position:absolute; left:0; top:0; width:100%; transform-origin:50% 0; }
      .page-label { position:absolute; left:0; right:0; text-align:center; font:600 30px/1.2 "Poppins"; color:var(--muted); }
      #camcard { position:absolute; left:-63px; top:1202px; width:1206px; height:860px; border-radius:198px; background:#FFFFFF; box-shadow:var(--shadow); }
      #cover { position:absolute; left:50%; transform:translateX(-50%); background:#FFFFFF; color:#111111; border-radius:44px; padding:28px 50px; font-weight:700; line-height:1.02; letter-spacing:-0.03em; text-align:center; box-shadow: 0 40px 90px rgba(24,24,32,.16), 0 14px 30px rgba(24,24,32,.08); white-space:nowrap; }`;

export function writeLuxuryComposition(dir: string, g: CompiledGraphic, opts: LuxuryCompositionOptions): LuxuryComposition {
  const assets = join(dir, "assets");
  mkdirSync(join(assets, "fonts"), { recursive: true });
  const gsap = gsapScript();
  if (!gsap) throw new Error("GSAP is missing from the runtime; run `shorts-studio doctor --setup`");
  copyFileSync(gsap, join(assets, "gsap.min.js"));
  const faces = [
    ["Poppins-Regular.ttf", 400],
    ["Poppins-SemiBold.ttf", 600],
    ["Poppins-Bold.ttf", 700],
    ["Poppins-ExtraBold.ttf", 800],
  ] as const;
  const fontCss = faces
    .map(([file, weight]) => {
      copyFileSync(join(paths().fontsDir, file), join(assets, "fonts", basename(file)));
      return `      @font-face { font-family: "Poppins"; src: url("assets/fonts/${file}"); font-weight: ${weight}; font-style: normal; font-display: block; }`;
    })
    .join("\n");
  // Poppins has no 500; map it to 400 explicitly so the browser never synthesizes.
  const fontAlias = `      @font-face { font-family: "Poppins"; src: url("assets/fonts/Poppins-Regular.ttf"); font-weight: 500; font-style: normal; font-display: block; }`;

  const sub = Math.max(1, Math.round(opts.subframes));
  const renderFps = opts.fps * sub;
  const frames = opts.frames * sub;
  const durationS = opts.frames / opts.fps;
  const cam: CameraFrame[] = sampleCamera({
    frames,
    fps: renderFps,
    init: g.init,
    moves: g.moves,
    glide: { scaleDelta: g.glide.scaleDelta, driftY: g.glide.driftY, dur: durationS },
    anchor: g.anchor,
    shutter: opts.motionBlur.shutter,
    maxSigma: opts.motionBlur.maxSigma,
    blur: opts.motionBlur.enabled && sub === 1,
  });
  const camRows = cam.map((c) => [Math.round(c.transform.tx * 100) / 100, Math.round(c.transform.ty * 100) / 100, Math.round(c.transform.s * 1e5) / 1e5, Math.round(c.blur.sx * 100) / 100, Math.round(c.blur.sy * 100) / 100]);
  const blurFrames = cam.filter((c) => c.blur.sigma > 0).length;
  const peakSigma = Math.max(0, ...cam.map((c) => c.blur.sigma));

  const cover = opts.cover ? coverHtml(opts.metrics, opts.cover.title) : null;
  const items = g.items.map((it) => itemHtml(it, opts.metrics, assets)).join("\n        ");
  const prevFocus = { id: null as string | null };
  const actions = g.actions.map((a) => actionJs(a, g, prevFocus)).join("\n      ");
  const radars = g.items.filter((i): i is Extract<Item, { kind: "radar" }> => i.kind === "radar");
  const connectors = g.items.filter((i) => i.kind === "connector");
  const lensMask = opts.split ? "-webkit-mask-image: linear-gradient(to bottom, #000 0px, #000 900px, transparent 1060px); mask-image: linear-gradient(to bottom, #000 0px, #000 900px, transparent 1060px);" : "";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <title>Shorts Studio · Luxury Tech · ${esc(g.subject)}</title>
    <!-- Generated by Shorts Studio (packages/adapters/src/render/luxury.ts). World camera sampled per frame at ${renderFps} fps. -->
    <script src="assets/gsap.min.js"></script>
    <style>
${fontCss}
${fontAlias}
${CSS}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="run" data-start="0" data-width="1080" data-height="1920" data-fps="${renderFps}" data-duration="${durationS.toFixed(6)}">
      <svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="mb" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB"><feGaussianBlur id="mbg" stdDeviation="0 0" edgeMode="duplicate"/></filter></svg>
      <div id="lens" style="${lensMask}">
        <div id="world">
        ${connectorSvg(g.items)}
        ${items}
        </div>
      </div>
      ${g.items.filter((i): i is Extract<Item, { kind: "source-page" }> => i.kind === "source-page").map((i) => sourcePageHtml(i, assets)).join("\n      ")}
      ${opts.split ? '<div id="camcard"></div>' : ""}
      ${cover?.html ?? ""}
    </div>
    <script>
      (function () {
        var FPS = ${renderFps};
        var D = ${durationS.toFixed(6)};
        var CAM = ${JSON.stringify(camRows)};
        var tl = gsap.timeline({ paused: true });
        var world = document.getElementById("world");
        var lens = document.getElementById("lens");
        var blur = document.getElementById("mbg");
        gsap.set(world, { transformOrigin: "0 0", x: CAM[0][0], y: CAM[0][1], scale: CAM[0][2], force3D: false });
        gsap.set(".it", { filter: "blur(0px)" });
        for (var k = 1; k < CAM.length; k++) {
          var c = CAM[k], p = CAM[k - 1], at = (k - 0.5) / FPS;
          if (c[0] !== p[0] || c[1] !== p[1] || c[2] !== p[2]) tl.set(world, { x: c[0], y: c[1], scale: c[2] }, at);
          if (c[3] !== p[3] || c[4] !== p[4]) {
            tl.set(blur, { attr: { stdDeviation: c[3] + " " + c[4] } }, at);
            var on = c[3] > 0 || c[4] > 0, was = p[3] > 0 || p[4] > 0;
            if (on !== was) tl.set(lens, { filter: on ? "url(#mb)" : "none" }, at);
          }
        }
        function typeChars(sel, n, t, dur) {
          var chars = document.querySelectorAll(sel + " .ch");
          for (var i = 0; i < chars.length; i++) {
            gsap.set(chars[i], { display: "none" });
            tl.set(chars[i], { display: "inline" }, t + (dur * (i + 1)) / Math.max(1, chars.length));
          }
          var caret = document.querySelector(sel + "-caret") || document.querySelector(sel + " .caret");
          if (caret) {
            gsap.set(caret, { autoAlpha: 0 });
            tl.set(caret, { autoAlpha: 1 }, Math.max(0, t - 0.4));
            // Finite deterministic blink after typing: on/off every 0.5 s until the run ends.
            for (var b = t + dur + 0.5, on = false; b < D; b += 0.5, on = !on) tl.set(caret, { autoAlpha: on ? 1 : 0 }, b);
          }
        }
        function press(sel, t) {
          tl.to(sel, { scale: 0.9, duration: 0.08, ease: "power2.in" }, t);
          tl.to(sel, { scale: 1, duration: 0.16, ease: "power2.out" }, t + 0.08);
        }
        function streamWords(sel, t, dur) {
          var ws = document.querySelectorAll(sel);
          for (var i = 0; i < ws.length; i++) {
            gsap.set(ws[i], { autoAlpha: 0 });
            tl.to(ws[i], { autoAlpha: 1, duration: 0.12, ease: "none" }, t + (dur * i) / Math.max(1, ws.length));
          }
        }
        ${radars
          .map((r) => {
            const period = 2.4;
            const turns = durationS / period;
            const blipTimes = Array.from({ length: r.blips }, (_, i) => {
              const angle = (i * 137.5 + 40) % 360;
              return ((angle / 360) * period).toFixed(4);
            });
            return `tl.fromTo("#i-${r.id}-sweep", { rotation: 0 }, { rotation: ${(360 * turns).toFixed(3)}, duration: D, ease: "none" }, 0);\n        ${blipTimes.map((bt, i) => `tl.fromTo("#i-${r.id}-b${i}", { autoAlpha: 0, scale: 0.4 }, { autoAlpha: 1, scale: 1, duration: 0.25, ease: "power2.out" }, ${bt});`).join("\n        ")}`;
          })
          .join("\n        ")}
        ${connectors.map((c) => (c.enter ? "" : `gsap.set("#i-${c.id} .wire", { strokeDasharray: 1, strokeDashoffset: 0 });`)).join("\n        ")}
        ${g.actions
          .filter((a) => a.kind === "enter" && connectors.some((c) => c.id === a.target))
          .map((a) => `gsap.set("#i-${a.target} .wire", { strokeDasharray: 1, strokeDashoffset: 1 }); tl.to("#i-${a.target} .wire", { strokeDashoffset: 0, duration: 0.5, ease: "power2.inOut" }, ${a.t.toFixed(4)});`)
          .join("\n        ")}
      ${actions}
        ${cover ? `tl.set("#cover", { autoAlpha: 0 }, ${(0.5 / renderFps).toFixed(6)});` : ""}
        tl.set({}, {}, D);
        window.__timelines = window.__timelines || {};
        window.__timelines["run"] = tl;
      })();
    </script>
  </body>
</html>
`;
  writeFileSync(join(dir, "index.html"), html);
  writeFileSync(join(dir, "camera.json"), JSON.stringify({ fps: renderFps, anchor: g.anchor, moves: g.moves, frames: camRows.length, blurFrames, peakSigma }, null, 1));
  return { dir, durationS, renderFps, blurFrames, peakSigma, landingSharp: cam[0]!.blur.sigma === 0, coverLines: cover?.lines ?? [] };
}

/** Transparent one-frame cover (frame zero) for edits whose first run shows camera footage. */
export function writeCoverComposition(dir: string, title: string, metrics: MetricsTable, fps = 60): { dir: string; lines: string[] } {
  const assets = join(dir, "assets");
  mkdirSync(join(assets, "fonts"), { recursive: true });
  const gsap = gsapScript();
  if (!gsap) throw new Error("GSAP is missing from the runtime; run `shorts-studio doctor --setup`");
  copyFileSync(gsap, join(assets, "gsap.min.js"));
  copyFileSync(join(paths().fontsDir, "Poppins-Bold.ttf"), join(assets, "fonts", "Poppins-Bold.ttf"));
  const cover = coverHtml(metrics, title);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <title>Shorts Studio · Luxury Tech cover</title>
    <script src="assets/gsap.min.js"></script>
    <style>
      @font-face { font-family: "Poppins"; src: url("assets/fonts/Poppins-Bold.ttf"); font-weight: 700; font-style: normal; font-display: block; }
      html, body { margin:0; padding:0; background:transparent; }
      #root { position:relative; width:1080px; height:1920px; overflow:hidden; background:transparent; font-family:"Poppins"; }
      #cover span { display:block; white-space:nowrap; }
      #cover { position:absolute; left:50%; transform:translateX(-50%); background:#FFFFFF; color:#111111; border-radius:44px; padding:28px 50px; font-weight:700; line-height:1.02; letter-spacing:-0.03em; text-align:center; box-shadow: 0 40px 90px rgba(24,24,32,.16), 0 14px 30px rgba(24,24,32,.08); white-space:nowrap; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="cover" data-start="0" data-width="1080" data-height="1920" data-fps="${fps}" data-duration="${(1 / fps).toFixed(6)}">
      ${cover.html}
    </div>
    <script>
      var tl = gsap.timeline({ paused: true });
      tl.set({}, {}, ${(1 / fps).toFixed(6)});
      window.__timelines = window.__timelines || {};
      window.__timelines["cover"] = tl;
    </script>
  </body>
</html>
`;
  writeFileSync(join(dir, "index.html"), html);
  return { dir, lines: cover.lines };
}

/** Region rendered for the CTA overlay: the comment box plus room for its shadow. */
export const CTA_MARGIN = 60;

/**
 * Outro CTA: a transparent overlay of the comment box only (default avatar, the real
 * keyword typed with a finite blinking caret, then a Post press). Times are relative
 * to the overlay start; every layer ends at END.
 */
export function writeCtaComposition(dir: string, opts: { keyword: string; durationS: number; typeAtS: number; typeDurS: number; postAtS: number; box: { w: number; h: number }; fps?: number }): { dir: string; width: number; height: number } {
  const fps = opts.fps ?? 60;
  const assets = join(dir, "assets");
  mkdirSync(join(assets, "fonts"), { recursive: true });
  const gsap = gsapScript();
  if (!gsap) throw new Error("GSAP is missing from the runtime; run `shorts-studio doctor --setup`");
  copyFileSync(gsap, join(assets, "gsap.min.js"));
  for (const f of ["Poppins-SemiBold.ttf", "Poppins-Bold.ttf"]) copyFileSync(join(paths().fontsDir, f), join(assets, "fonts", f));
  const W = opts.box.w + 2 * CTA_MARGIN;
  const H = opts.box.h + 2 * CTA_MARGIN;
  const chars = [...opts.keyword].map((ch) => `<span class="ch">${esc(ch)}</span>`).join("");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <title>Shorts Studio · Luxury Tech CTA</title>
    <script src="assets/gsap.min.js"></script>
    <style>
      @font-face { font-family: "Poppins"; src: url("assets/fonts/Poppins-SemiBold.ttf"); font-weight: 600; font-style: normal; font-display: block; }
      @font-face { font-family: "Poppins"; src: url("assets/fonts/Poppins-Bold.ttf"); font-weight: 700; font-style: normal; font-display: block; }
      html, body { margin:0; padding:0; background:transparent; }
      #root { position:relative; width:${W}px; height:${H}px; overflow:hidden; background:transparent; font-family:"Poppins"; }
      #box { position:absolute; left:${CTA_MARGIN}px; top:${CTA_MARGIN}px; width:${opts.box.w}px; height:${opts.box.h}px; box-sizing:border-box; border-radius:48px; background:#FFFFFF; box-shadow: 0 30px 60px rgba(24,24,32,.16), 0 10px 24px rgba(24,24,32,.10); display:flex; align-items:center; gap:30px; padding:0 34px 0 40px; }
      .avatar { width:104px; height:104px; border-radius:52px; background:#ECECE8; color:#B9B9B3; display:flex; align-items:center; justify-content:center; flex:none; }
      .field { flex:1; font-weight:600; font-size:56px; line-height:1; color:#111111; white-space:nowrap; overflow:hidden; }
      .caret { display:inline-block; width:4px; height:58px; margin-left:4px; vertical-align:middle; background:#D97757; }
      .post { flex:none; height:96px; padding:0 40px; border-radius:48px; background:#D97757; color:#FFFFFF; font-weight:700; font-size:38px; display:flex; align-items:center; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="cta" data-start="0" data-width="${W}" data-height="${H}" data-fps="${fps}" data-duration="${opts.durationS.toFixed(6)}">
      <div id="box">
        <div class="avatar">${iconSvg("person", 64, 1.6)}</div>
        <div class="field" id="field">${chars}<span class="caret" id="caret"></span></div>
        <div class="post" id="post">Post</div>
      </div>
    </div>
    <script>
      (function () {
        var D = ${opts.durationS.toFixed(6)};
        var tl = gsap.timeline({ paused: true });
        tl.fromTo("#box", { autoAlpha: 0, y: 28 }, { autoAlpha: 1, y: 0, duration: 0.35, ease: "power3.out" }, 0);
        var chars = document.querySelectorAll("#field .ch");
        for (var i = 0; i < chars.length; i++) {
          gsap.set(chars[i], { display: "none" });
          tl.set(chars[i], { display: "inline" }, ${opts.typeAtS.toFixed(4)} + (${opts.typeDurS.toFixed(4)} * (i + 1)) / chars.length);
        }
        // Finite deterministic caret blink: steady while typing, then on/off every 0.5 s until END.
        for (var b = ${(opts.typeAtS + opts.typeDurS + 0.5).toFixed(4)}, on = false; b < D; b += 0.5, on = !on) tl.set("#caret", { autoAlpha: on ? 1 : 0 }, b);
        tl.to("#post", { scale: 0.9, duration: 0.08, ease: "power2.in" }, ${opts.postAtS.toFixed(4)});
        tl.to("#post", { scale: 1, duration: 0.16, ease: "power2.out" }, ${(opts.postAtS + 0.08).toFixed(4)});
        tl.set({}, {}, D);
        window.__timelines = window.__timelines || {};
        window.__timelines["cta"] = tl;
      })();
    </script>
  </body>
</html>
`;
  writeFileSync(join(dir, "index.html"), html);
  return { dir, width: W, height: H };
}
