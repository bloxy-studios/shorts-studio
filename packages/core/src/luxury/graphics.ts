/**
 * Luxury Tech graphics brief: director-authored, word-anchored specs per layout run,
 * compiled into run-relative camera moves, item actions and synthesized-sound events.
 */
import { z } from "zod";
import { FLICKS_PER_SECOND, type Flicks } from "../time.ts";
import { normalizeToken } from "../captions/lexicon.ts";
import { whipMidpoint, type CamMove, type CamState } from "./camera.ts";
import type { LineIntent, LtLayout } from "./layout.ts";

export const TimeRefSchema = z.object({
  /** Seconds from the run start. */
  at: z.number().min(0).optional(),
  /** A word spoken in the run (case/punctuation-insensitive); `nth` picks a repeat. */
  word: z.string().optional(),
  nth: z.int().min(1).default(1),
  /** Seconds before the word onset (defaults depend on the action). */
  lead: z.number().optional(),
});

const Box = { id: z.string().regex(/^[a-z][a-z0-9-]*$/), x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(), enter: TimeRefSchema.optional() };
const Tone = z.enum(["ink", "clay", "check", "stamp"]);

export const ItemSchema = z.discriminatedUnion("kind", [
  z.object({ ...Box, kind: z.literal("card"), eyebrow: z.string().optional(), title: z.string().optional(), body: z.string().optional(), icon: z.string().optional(), iconTone: Tone.default("clay"), align: z.enum(["left", "center"]).default("left") }),
  z.object({ ...Box, kind: z.literal("stat"), value: z.string(), label: z.string(), icon: z.string().optional() }),
  z.object({
    ...Box,
    kind: z.literal("list"),
    title: z.string().optional(),
    rows: z.array(z.object({ text: z.string(), mark: z.enum(["check", "cross", "dot"]).default("dot"), markAt: TimeRefSchema.optional(), sound: z.boolean().optional() })).min(1).max(5),
  }),
  z.object({ ...Box, kind: z.literal("tile"), icon: z.string(), label: z.string().optional(), tone: Tone.default("ink") }),
  z.object({ ...Box, kind: z.literal("code"), title: z.string(), lines: z.array(z.string()).min(1), typeAt: TimeRefSchema, cps: z.number().positive().default(28) }),
  z.object({ ...Box, kind: z.literal("chat"), app: z.string(), prompt: z.string(), typeAt: TimeRefSchema, sendAt: TimeRefSchema, response: z.string(), responseAt: TimeRefSchema, cps: z.number().positive().default(26) }),
  z.object({ ...Box, kind: z.literal("document"), title: z.string(), lines: z.array(z.string()).min(1), stamp: z.object({ text: z.string(), at: TimeRefSchema }).optional() }),
  z.object({ ...Box, kind: z.literal("image"), src: z.string(), fit: z.enum(["cover", "contain"]).default("cover"), caption: z.string().optional() }),
  z.object({ ...Box, kind: z.literal("radar"), label: z.string().optional(), blips: z.int().min(0).max(6).default(3) }),
  z.object({ ...Box, kind: z.literal("text"), text: z.string(), size: z.enum(["headline", "subhead", "body"]).default("headline"), tone: Tone.default("ink"), align: z.enum(["left", "center"]).default("center") }),
  // Fixed source-page frame (x 24, y 200, 1032×1040, r 36) over a washed blurred clone; the capture
  // pans/zooms inside the frame. Not part of the moving world.
  z.object({
    ...Box,
    x: z.number().default(24),
    y: z.number().default(200),
    w: z.number().positive().default(1032),
    h: z.number().positive().default(1040),
    kind: z.literal("source-page"),
    src: z.string(),
    label: z.string().optional(),
    pan: z.array(z.object({ when: TimeRefSchema, y: z.number().min(0).max(1), scale: z.number().min(1).max(1.6).default(1), dur: z.number().positive().default(0.8) })).default([]),
  }),
  // A wire between two items; its geometry comes from them.
  z.object({ ...Box, x: z.number().default(0), y: z.number().default(0), w: z.number().positive().default(1), h: z.number().positive().default(1), kind: z.literal("connector"), from: z.string(), to: z.string() }),
]);

export const CameraSpecSchema = z.object({
  kind: z.enum(["step", "push", "pull", "whip"]),
  /** Item id, or a world point. */
  to: z.union([z.string(), z.object({ x: z.number(), y: z.number() })]),
  scale: z.number().positive().optional(),
  dur: z.number().positive().optional(),
  when: TimeRefSchema,
});

export const GraphicRunSpecSchema = z.object({
  /** Planned run id, or the line ids it covers (+ part when a line was split). */
  run: z.string().optional(),
  lines: z.array(z.string()).optional(),
  part: z.int().min(1).optional(),
  subject: z.string(),
  items: z.array(ItemSchema).min(1),
  /** Initial camera framing (default: the layout anchor at 1×) — e.g. centred on the first subject. */
  start: z.object({ to: z.union([z.string(), z.object({ x: z.number(), y: z.number() })]), scale: z.number().positive().default(1) }).optional(),
  camera: z.array(CameraSpecSchema).default([]),
  focus: z.array(z.object({ target: z.string(), when: TimeRefSchema, dur: z.number().positive().default(0.6) })).default([]),
  innerZoom: z.array(z.object({ target: z.string(), scale: z.number().min(1.15).max(1.4), dur: z.number().min(0.4).max(0.7).default(0.55), origin: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).default({ x: 0.5, y: 0.5 }), when: TimeRefSchema })).default([]),
  clicks: z.array(z.object({ target: z.string(), when: TimeRefSchema })).default([]),
  glide: z.object({ scaleDelta: z.number().min(0).max(0.04).default(0.03), driftY: z.number().min(-30).max(30).default(-12) }).default({ scaleDelta: 0.03, driftY: -12 }),
  lowContent: z.boolean().default(false),
  sources: z.array(z.object({ url: z.string(), kind: z.enum(["capture", "official-asset", "reconstruction", "generated"]), disclosed: z.boolean(), note: z.string().optional() })).default([]),
});

export const GraphicsBriefSchema = z.object({
  schemaVersion: z.literal(1),
  /** Editorial intent per line id (drives the layout plan). */
  intents: z.record(z.string(), z.enum(["hook", "point", "opinion", "screen", "card", "list", "cta", "outro"])).default({}),
  title: z.string().optional(),
  cta: z.object({ keyword: z.string(), requestedBy: z.enum(["speech", "brief", "user"]) }).nullable().default(null),
  runs: z.array(GraphicRunSpecSchema).default([]),
});

export type TimeRef = z.infer<typeof TimeRefSchema>;
export type Item = z.infer<typeof ItemSchema>;
export type CameraSpec = z.infer<typeof CameraSpecSchema>;
export type GraphicRunSpec = z.infer<typeof GraphicRunSpecSchema>;
export type GraphicsBrief = z.infer<typeof GraphicsBriefSchema>;
export type BriefIntents = Record<string, LineIntent>;

export interface RunWord {
  id: string;
  text: string;
  /** Output-timeline flicks. */
  start: Flicks;
  end: Flicks;
}

export type ActionKind = "enter" | "type" | "send" | "response" | "mark" | "stamp" | "focus" | "inner-zoom" | "click" | "page-pan";

export interface CompiledAction {
  kind: ActionKind;
  target: string;
  /** Run-relative seconds. */
  t: number;
  dur: number;
  /** Row index for list marks. */
  index?: number;
  scale?: number;
  origin?: { x: number; y: number };
  /** page-pan: scroll position (0 = top, 1 = bottom of the capture). */
  y?: number;
}

export type SoundKind = "click" | "tick" | "pop" | "chime" | "whoosh";

export interface CompiledSound {
  kind: SoundKind;
  /** Run-relative seconds of the sound's anchor (onset; whoosh: loudest point). */
  t: number;
  reason: string;
  linked: string;
}

export interface CompiledGraphic {
  subject: string;
  layout: LtLayout;
  anchor: { x: number; y: number };
  zone: { y0: number; y1: number };
  init: CamState;
  moves: CamMove[];
  actions: CompiledAction[];
  sounds: CompiledSound[];
  items: Item[];
  glide: { scaleDelta: number; driftY: number };
  durationS: number;
  warnings: string[];
}

/** Content zone and camera anchor per layout (preset geometry). */
export function contentZone(layout: LtLayout, lowContent = false): { zone: { y0: number; y1: number }; anchor: { x: number; y: number } } {
  if (layout === "lt-split") return { zone: { y0: 40, y1: 900 }, anchor: { x: 540, y: 470 } };
  if (lowContent) return { zone: { y0: 680, y1: 1230 }, anchor: { x: 540, y: 955 } };
  return { zone: { y0: 120, y1: 1230 }, anchor: { x: 540, y: 675 } };
}

const DEFAULT_LEAD: Record<string, number> = { step: 0.25, push: 0.1, pull: 0.1, whip: 0.45, enter: 0.12, type: 0, send: 0, response: 0, mark: 0, stamp: 0, focus: 0.1, "inner-zoom": 0.1, click: 0.05 };

export function resolveTime(ref: TimeRef, words: RunWord[], runStart: Flicks, kind: string, durationS: number): number {
  if (ref.at !== undefined) return Math.min(ref.at, durationS);
  if (!ref.word) throw new Error(`time reference needs "at" or "word"`);
  const want = normalizeToken(ref.word);
  const hits = words.filter((w) => normalizeToken(w.text) === want);
  const w = hits[ref.nth - 1];
  if (!w) throw new Error(`word "${ref.word}"${ref.nth > 1 ? ` (#${ref.nth})` : ""} is not spoken in this run; run words: ${words.map((x) => x.text).join(" ")}`);
  const lead = ref.lead ?? DEFAULT_LEAD[kind] ?? 0;
  return Math.max(0, (w.start - runStart) / FLICKS_PER_SECOND - lead);
}

const center = (it: Item): { x: number; y: number } => ({ x: it.x + it.w / 2, y: it.y + it.h / 2 });

/** Item rectangle on screen for a camera state (world point `cam` at `anchor`, zoom cam.s). */
export function screenBox(it: { x: number; y: number; w: number; h: number }, cam: CamState, anchor: { x: number; y: number }): { x: number; y: number; w: number; h: number } {
  return { x: anchor.x + cam.s * (it.x - cam.x), y: anchor.y + cam.s * (it.y - cam.y), w: it.w * cam.s, h: it.h * cam.s };
}

/** Compiles one run spec against the run's spoken words. Throws on unresolvable references. */
export function compileGraphic(spec: GraphicRunSpec, ctx: { layout: LtLayout; runStart: Flicks; runEnd: Flicks; words: RunWord[]; fps: number }): CompiledGraphic {
  const durationS = (ctx.runEnd - ctx.runStart) / FLICKS_PER_SECOND;
  const { zone, anchor } = contentZone(ctx.layout, spec.lowContent);
  const warnings: string[] = [];
  const byId = new Map(spec.items.map((i) => [i.id, i]));
  if (byId.size !== spec.items.length) throw new Error(`duplicate item ids in "${spec.subject}"`);
  const time = (ref: TimeRef, kind: string) => resolveTime(ref, ctx.words, ctx.runStart, kind, durationS);
  const startTarget = spec.start ? (typeof spec.start.to === "string" ? byId.get(spec.start.to) : null) : null;
  if (spec.start && typeof spec.start.to === "string" && !startTarget) throw new Error(`camera start "${spec.start.to}" is not an item`);
  const startPoint = startTarget ? center(startTarget) : spec.start && typeof spec.start.to !== "string" ? spec.start.to : anchor;
  const init: CamState = { x: startPoint.x, y: startPoint.y, s: spec.start?.scale ?? 1 };

  // Camera moves: resolved, sorted, non-overlapping, within preset limits.
  const moves: CamMove[] = [];
  let state = init;
  for (const c of [...spec.camera].sort((a, b) => time(a.when, a.kind) - time(b.when, b.kind))) {
    const target = typeof c.to === "string" ? byId.get(c.to) : null;
    if (typeof c.to === "string" && !target) throw new Error(`camera target "${c.to}" is not an item`);
    const point = target ? center(target) : (c.to as { x: number; y: number });
    const fitScale = target ? Math.min(1.6, (1080 - 120) / target.w, (zone.y1 - zone.y0 - 80) / target.h) : 1.25;
    const scale = c.scale ?? (c.kind === "push" ? Math.max(1.05, fitScale) : c.kind === "pull" ? 1 : state.s);
    if (c.kind === "push" && scale > 1.6) throw new Error(`push to ${scale.toFixed(2)}× exceeds the 1.6× limit`);
    const dur = c.dur ?? (c.kind === "step" ? 0.5 : c.kind === "push" ? 1.5 : c.kind === "pull" ? 1.3 : 1.05);
    if (c.kind === "push" && (dur < 1.2 || dur > 2)) warnings.push(`push duration ${dur}s outside 1.2–2 s`);
    if (c.kind === "pull" && (dur < 1 || dur > 2)) warnings.push(`pull duration ${dur}s outside 1–2 s`);
    const t0 = time(c.when, c.kind);
    const prev = moves[moves.length - 1];
    if (prev && t0 < prev.t0 + prev.dur - 1e-6) throw new Error(`camera ${c.kind} at ${t0.toFixed(2)} s overlaps the previous ${prev.kind} (ends ${(prev.t0 + prev.dur).toFixed(2)} s)`);
    if (t0 + dur > durationS + 1e-6) throw new Error(`camera ${c.kind} ends at ${(t0 + dur).toFixed(2)} s, after the run (${durationS.toFixed(2)} s)`);
    const to = c.kind === "pull" && typeof c.to !== "string" && c.scale === undefined ? { ...init } : { x: point.x, y: point.y, s: scale };
    moves.push({ kind: c.kind, t0, dur, to, ease: c.kind === "step" ? "power3.inOut" : c.kind === "whip" ? undefined : "power2.inOut", ...(c.kind === "whip" ? { departFrac: 0.45 / 1.05 } : {}) });
    state = to;
  }
  if (moves.filter((m) => m.kind === "whip").length > 1) throw new Error(`at most one whip per run (got ${moves.filter((m) => m.kind === "whip").length})`);

  // Item actions.
  const actions: CompiledAction[] = [];
  const sounds: CompiledSound[] = [];
  for (const it of spec.items) {
    if (it.enter) {
      const t = time(it.enter, "enter");
      actions.push({ kind: "enter", target: it.id, t, dur: 0.42 });
      if (it.kind !== "connector" && it.kind !== "text") sounds.push({ kind: "pop", t: t + 0.3, reason: `${it.id} lands`, linked: it.id });
    }
    if (it.kind === "list") {
      it.rows.forEach((row, i) => {
        if (!row.markAt) return;
        const t = time(row.markAt, "mark");
        actions.push({ kind: "mark", target: it.id, index: i, t, dur: 0.35 });
        if (row.sound ?? row.mark === "check") sounds.push({ kind: row.mark === "cross" ? "pop" : "chime", t, reason: `${it.id} row ${i + 1} ${row.mark}`, linked: it.id });
      });
    }
    if (it.kind === "code") {
      const t = time(it.typeAt, "type");
      const chars = it.lines.join("\n").length;
      actions.push({ kind: "type", target: it.id, t, dur: chars / it.cps });
      for (let k = 0; k < chars; k += 2) sounds.push({ kind: "tick", t: t + k / it.cps, reason: `${it.id} typing`, linked: it.id });
    }
    if (it.kind === "chat") {
      const tType = time(it.typeAt, "type");
      const tSend = time(it.sendAt, "send");
      const tResp = time(it.responseAt, "response");
      if (!(tType < tSend && tSend < tResp)) throw new Error(`chat ${it.id}: type < send < response required`);
      const typeDur = Math.min(it.prompt.length / it.cps, tSend - tType - 0.15);
      actions.push({ kind: "type", target: it.id, t: tType, dur: typeDur });
      for (let k = 0; k < it.prompt.length; k += 2) if (tType + k / it.cps < tType + typeDur) sounds.push({ kind: "tick", t: tType + k / it.cps, reason: `${it.id} typing`, linked: it.id });
      actions.push({ kind: "send", target: it.id, t: tSend, dur: 0.2 });
      sounds.push({ kind: "click", t: tSend, reason: `${it.id} send pressed`, linked: it.id });
      const respDur = Math.min(Math.max(0.6, it.response.split(/\s+/).length * 0.09), durationS - tResp);
      actions.push({ kind: "response", target: it.id, t: tResp, dur: respDur });
      sounds.push({ kind: "chime", t: tResp, reason: `${it.id} answer appears`, linked: it.id });
    }
    if (it.kind === "document" && it.stamp) {
      const t = time(it.stamp.at, "stamp");
      actions.push({ kind: "stamp", target: it.id, t, dur: 0.3 });
      sounds.push({ kind: "pop", t: t + 0.12, reason: `${it.id} stamped`, linked: it.id });
    }
    if (it.kind === "connector" && (!byId.has(it.from) || !byId.has(it.to))) throw new Error(`connector ${it.id} references a missing item`);
    if (it.kind === "source-page") {
      for (const pn of it.pan) actions.push({ kind: "page-pan", target: it.id, t: time(pn.when, "step"), dur: pn.dur, y: pn.y, scale: pn.scale });
      if (!spec.sources.length) warnings.push(`${it.id}: source page without a recorded source (add sources: [{url, kind: "capture", disclosed}])`);
    }
  }
  for (const f of spec.focus) {
    if (!byId.has(f.target)) throw new Error(`focus target "${f.target}" is not an item`);
    actions.push({ kind: "focus", target: f.target, t: time(f.when, "focus"), dur: f.dur });
  }
  for (const z of spec.innerZoom) {
    if (!byId.has(z.target)) throw new Error(`inner-zoom target "${z.target}" is not an item`);
    actions.push({ kind: "inner-zoom", target: z.target, t: time(z.when, "inner-zoom"), dur: z.dur, scale: z.scale, origin: z.origin });
  }
  for (const c of spec.clicks) {
    if (!byId.has(c.target)) throw new Error(`click target "${c.target}" is not an item`);
    const t = time(c.when, "click");
    actions.push({ kind: "click", target: c.target, t, dur: 0.22 });
    sounds.push({ kind: "click", t, reason: `${c.target} pressed`, linked: c.target });
  }
  for (const m of moves.filter((x) => x.kind === "whip")) sounds.push({ kind: "whoosh", t: whipMidpoint(m), reason: "graphics whip midpoint", linked: "camera" });

  // Landing frame (screen space under the initial camera): ≤ 2 subjects, inside the content zone.
  const initial = spec.items.filter((i) => !i.enter && i.kind !== "connector" && i.kind !== "source-page").map((i) => ({ id: i.id, ...screenBox(i, init, anchor) }));
  const inView = initial.filter((i) => i.x + i.w > 0 && i.x < 1080 && i.y + i.h > zone.y0 && i.y < zone.y1);
  for (const i of inView) {
    if (i.x < 24 || i.x + i.w > 1056 || i.y < zone.y0 - 1 || i.y + i.h > zone.y1 + 1) warnings.push(`${i.id} extends outside the ${ctx.layout.replace("lt-", "")} content zone (y ${zone.y0}–${zone.y1}) on the landing frame`);
  }
  if (inView.length > 2) warnings.push(`${inView.length} items on the landing frame (one dominant subject + at most one supporting cue)`);
  for (const a of actions) if (a.t + a.dur > durationS + 1e-6 && a.kind !== "focus") warnings.push(`${a.kind} on ${a.target} runs past the run end`);
  return { subject: spec.subject, layout: ctx.layout, anchor, zone, init, moves, actions: actions.sort((a, b) => a.t - b.t), sounds: sounds.sort((a, b) => a.t - b.t), items: spec.items, glide: spec.glide, durationS, warnings };
}

/**
 * Frame zero carries the cover title (y 262–603): the intro graphic must sit below
 * `belowY` on that frame. Starts the camera so the landing-frame content is lowered,
 * then steps (power3.inOut) to the authored framing right after frame zero.
 */
export function withCoverReveal(g: CompiledGraphic, fps: number, belowY = 640): CompiledGraphic {
  const visible = g.items
    .filter((i) => !g.actions.some((a) => a.kind === "enter" && a.target === i.id) && i.kind !== "connector")
    .map((i) => screenBox(i, g.init, g.anchor))
    .filter((b) => b.x + b.w > 0 && b.x < 1080);
  if (visible.length === 0) return g;
  const top = Math.min(...visible.map((b) => b.y));
  if (top >= belowY) return g;
  const t0 = 1 / fps;
  const first = g.moves[0]?.t0 ?? Infinity;
  const dur = Math.min(0.5, first - t0);
  if (dur < 0.25) return { ...g, warnings: [...g.warnings, `cover reveal skipped: first camera move at ${first.toFixed(2)} s leaves no room; intro graphic overlaps the cover region on frame 0`] };
  const shift = (belowY - top) / g.init.s;
  return { ...g, init: { ...g.init, y: g.init.y - shift }, moves: [{ kind: "step", t0, dur, to: g.init, ease: "power3.inOut" }, ...g.moves] };
}

/** A single readable card from the run's own words when the director gave no spec. */
export function autoGraphic(words: RunWord[], layout: LtLayout, keywords: string[]): GraphicRunSpec {
  const { zone } = contentZone(layout);
  const key = keywords.slice(0, 3).join(" ") || words.slice(0, 4).map((w) => w.text).join(" ");
  const h = Math.min(520, zone.y1 - zone.y0 - 160);
  return GraphicRunSpecSchema.parse({
    subject: key,
    items: [{ id: "hero", kind: "card", x: 110, y: Math.round((zone.y0 + zone.y1) / 2 - h / 2), w: 860, h, title: key.replace(/[.,!?;:]+$/g, ""), align: "center" }],
  });
}
