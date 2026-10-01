import {
  flicksPerFrame,
  formatTimecode,
  quantizeToFrame,
  type Box,
  type CropPath,
  type FaceSample,
  type FaceTrack,
  type Flicks,
  type Interval,
  type LayoutKind,
  type LayoutRun,
  type LayoutSlot,
  type Preset,
  type Rational,
  type TimeMap,
} from "../../../core/src/index.ts";
import { cropAt, cropSize, followPath, groupCrop, planShots, type Frame, type Shot, type ShotKind } from "../../../core/src/framing/crop.ts";
import { detectActiveSpeakers, speechTurns, type ActiveSpeaker } from "../../../core/src/framing/speakers.ts";

export interface FramingInput {
  preset: Preset;
  sourceId: string;
  frame: Frame;
  canvas: { width: number; height: number };
  fps: Rational;
  map: TimeMap;
  tracks: FaceTrack[];
  /** Source-time speech regions (VAD). */
  speech: Interval[];
  /** Output-time run spans (scene cuts / jump cuts already split). */
  spans: Array<{ start: Flicks; end: Flicks; punchIn: number; reason: string }>;
}

export interface FramingResult {
  layoutRuns: LayoutRun[];
  cropPaths: CropPath[];
  speakers: ActiveSpeaker[];
  notes: string[];
}

interface OutSample extends FaceSample {
  out: Flicks;
  track: string;
}

/** Face samples presented in the output, re-timed to output time. */
function outputSamples(map: TimeMap, sourceId: string, tracks: FaceTrack[]): Map<string, OutSample[]> {
  const res = new Map<string, OutSample[]>();
  for (const tr of tracks) {
    const xs: OutSample[] = [];
    for (const s of tr.samples) for (const out of map.srcToOut("video", sourceId, s.t)) xs.push({ ...s, out, track: tr.id });
    if (xs.length) res.set(tr.id, xs.sort((a, b) => a.out - b.out));
  }
  return res;
}

function medianBox(samples: FaceSample[]): Box {
  const med = (k: "x" | "y" | "w" | "h") => {
    const v = samples.map((s) => s.box[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)]!;
  };
  return { x: med("x"), y: med("y"), w: med("w"), h: med("h") };
}

function eyeLine(samples: FaceSample[]): number {
  const v = samples.map((s) => (s.landmarks ? (s.landmarks[1]! + s.landmarks[3]!) / 2 : s.box.y + s.box.h * 0.4)).sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)]!;
}

function fallbackKind(preset: Preset, twoShotFits: boolean): ShotKind {
  if (twoShotFits) return "two-shot";
  return preset.framing.lowConfidenceFallback === "dual-stack" ? "stack" : "wide";
}

export function planFraming(input: FramingInput): FramingResult {
  const { preset, frame, canvas, fps, map } = input;
  const W = canvas.width;
  const H = canvas.height;
  const aspect = W / H;
  const motionAllowed = preset.framing.cameraFootageMotion !== "none";
  const opts = { aspect, headroomFrac: preset.framing.headroomFrac, eyeLineFrac: preset.framing.eyeLineFrac };
  const notes: string[] = [];
  const cropPaths: CropPath[] = [];
  const layoutRuns: LayoutRun[] = [];
  const outSamples = outputSamples(map, input.sourceId, input.tracks);

  // Speech turns → active speakers (source time) → output time.
  const turns = speechTurns(input.speech);
  const speakers = detectActiveSpeakers(input.tracks, turns, input.speech);
  const outSpeakers: ActiveSpeaker[] = [];
  for (const sp of speakers) {
    for (const m of map.mapSourceInterval("video", input.sourceId, { start: sp.start, end: sp.end })) outSpeakers.push({ ...sp, start: m.outStart, end: m.outEnd });
  }

  let cropN = 0;
  const addCrop = (box: Box, slotAspect: number, reason: string, trackIds: string[], confidence: number, slot: string, t: Flicks, keys?: CropPath["keyframes"]): string => {
    const id = `crop${String(++cropN).padStart(3, "0")}`;
    cropPaths.push({
      id,
      sourceId: input.sourceId,
      slot,
      aspect: slotAspect,
      keyframes: keys && keys.length > 1 ? keys : [{ t, box, hold: true }],
      interpolation: keys && keys.length > 1 ? "linear" : "hold",
      trackIds,
      reason,
      confidence,
      manual: false,
    });
    return id;
  };
  const zone = (kind: string) => preset.captions.zones[kind] ?? preset.captions.zones["full-crop"] ?? { y0: 1180, y1: 1460 };
  let runN = 0;
  const addRun = (start: Flicks, end: Flicks, layout: LayoutKind, slots: LayoutSlot[], reason: string, exceptions: string[] = []) => {
    if (end <= start) return;
    layoutRuns.push({ id: `run${String(++runN).padStart(3, "0")}`, outStart: start, outEnd: end, layout, slots, captionZone: zone(layout), reason, eventIds: [], exceptions });
  };
  const full = (cropId: string): LayoutSlot => ({ slot: "main", cropPathId: cropId, region: { x: 0, y: 0, w: W, h: H }, radius: 0, blurPx: 0, dim: 0 });

  // Continuity: a two-shot of the same people keeps one crop across spans unless they moved.
  const groupCache = new Map<string, Box>();
  const stableGroup = (ids: string[], box: Box | null): Box | null => {
    if (!box) return null;
    const key = [...ids].sort().join("+");
    const prev = groupCache.get(key);
    if (prev && Math.abs(prev.x - box.x) < box.w * 0.06 && Math.abs(prev.y - box.y) < box.h * 0.06 && Math.abs(prev.w - box.w) < 1) return prev;
    groupCache.set(key, box);
    return box;
  };

  for (const span of input.spans) {
    const visible = [...outSamples.entries()]
      .map(([id, xs]) => ({ id, xs: xs.filter((s) => s.out >= span.start && s.out < span.end) }))
      .filter((v) => v.xs.length >= 3)
      .sort((a, b) => b.xs.length - a.xs.length);
    const spanLen = span.end - span.start;
    const dominant = visible.filter((v) => v.xs.length >= Math.max(3, visible[0] ? visible[0].xs.length * 0.3 : 3));

    if (dominant.length === 0) {
      // No usable face: fitted frame over a blurred backdrop (keeps any screen/wide content readable).
      const bg = cropAt(frame.width / 2, frame.height * 0.4, frame, { ...opts });
      const bgId = addCrop(bg, aspect, "backdrop: centred cover crop (blurred)", [], 0.5, "bg", span.start);
      const fitH = Math.round((W * frame.height) / frame.width / 2) * 2;
      const mainId = addCrop({ x: 0, y: 0, w: frame.width, h: frame.height }, frame.width / frame.height, "whole frame fitted (no face detected)", [], 0.5, "main", span.start);
      addRun(span.start, span.end, "fit-background", [
        { slot: "bg", cropPathId: bgId, region: { x: 0, y: 0, w: W, h: H }, radius: 0, blurPx: 40, dim: 0.35 },
        { slot: "main", cropPathId: mainId, region: { x: 0, y: Math.round((H - fitH) / 2), w: W, h: fitH }, radius: 0, blurPx: 0, dim: 0 },
      ], `${span.reason}; no face in ${formatTimecode(span.start)}–${formatTimecode(span.end)}: fitted frame`, ["no face detected"]);
      continue;
    }

    if (dominant.length === 1) {
      const v = dominant[0]!;
      const box = medianBox(v.xs);
      const centres = v.xs.map((s) => s.box.x + s.box.w / 2);
      const spread = Math.max(...centres) - Math.min(...centres);
      const size = cropSize(frame, aspect, span.punchIn);
      const moving = motionAllowed && spread > size.w * preset.framing.switching.deadZoneFrac * 2;
      if (moving) {
        const tr = input.tracks.find((t) => t.id === v.id)!;
        const srcA = map.outToSrc("video", span.start)[0]?.srcTime ?? 0;
        const srcB = map.outToSrc("video", span.end - flicksPerFrame(fps))[0]?.srcTime ?? srcA;
        const keys = followPath(tr, srcA, srcB + flicksPerFrame(fps), frame, { ...opts, scale: span.punchIn, deadZoneFrac: preset.framing.switching.deadZoneFrac, maxVelocityFracPerSec: preset.framing.switching.maxVelocityFracPerSec, smoothingMs: preset.framing.switching.smoothingMs }, (src) => {
          const outs = map.srcToOut("video", input.sourceId, src);
          return Math.max(span.start, Math.min(span.end - 1, quantizeToFrame(outs[0] ?? span.start, fps, "round")));
        });
        const first = keys[0]?.box ?? cropAt(box.x + box.w / 2, eyeLine(v.xs), frame, { ...opts, scale: span.punchIn });
        const id = addCrop(first, aspect, `follow ${v.id} (moves ${spread.toFixed(0)} px; dead zone ${(preset.framing.switching.deadZoneFrac * 100).toFixed(0)}%, max ${(preset.framing.switching.maxVelocityFracPerSec * 100).toFixed(0)}% of width/s)`, [v.id], 0.75, "main", span.start, keys.map((k) => ({ ...k, t: Math.max(span.start, k.t) })));
        addRun(span.start, span.end, "full-crop", [full(id)], `${span.reason}; following ${v.id}`);
      } else {
        const c = cropAt(box.x + box.w / 2, eyeLine(v.xs), frame, { ...opts, scale: span.punchIn });
        const id = addCrop(c, aspect, `static crop on ${v.id}${span.punchIn !== 1 ? ` (${span.punchIn.toFixed(2)}× punch-in)` : ""}`, [v.id], 0.75, "main", span.start);
        addRun(span.start, span.end, "full-crop", [full(id)], span.reason);
      }
      continue;
    }

    // Two or more faces: switch only at verified turns; otherwise a safe group layout.
    const faces = dominant.map((v) => ({ id: v.id, box: medianBox(v.xs), eye: eyeLine(v.xs) }));
    const groupBox = stableGroup(faces.map((f) => f.id), groupCrop(faces.map((f) => f.box), frame, { ...opts }));
    const fallback = fallbackKind(preset, groupBox !== null);
    const sw = preset.framing.switching;
    const shots: Shot[] = planShots(span, outSpeakers, {
      minHoldMs: sw.minHoldMs,
      hysteresisMs: sw.hysteresisMs,
      minConfidence: sw.minLinkConfidence,
      fallback,
      rapidPolicy: preset.framing.rapidAlternationPolicy === "switch" ? "switch" : groupBox ? "two-shot" : preset.framing.rapidAlternationPolicy,
    });
    for (const shot of shots) {
      const a = quantizeToFrame(shot.start, fps, "round");
      const b = quantizeToFrame(shot.end, fps, "round");
      if (b <= a) continue;
      if (shot.kind === "single" && shot.trackId) {
        const f = faces.find((x) => x.id === shot.trackId) ?? faces[0]!;
        const id = addCrop(cropAt(f.box.x + f.box.w / 2, f.eye, frame, { ...opts, scale: span.punchIn }), aspect, `speaker ${f.id}: ${shot.reason}`, [f.id], shot.confidence, "main", a);
        addRun(a, b, "full-crop", [full(id)], `active speaker ${f.id} (confidence ${shot.confidence.toFixed(2)})`);
      } else if (shot.kind === "two-shot" && groupBox) {
        const id = addCrop(groupBox, aspect, `two-shot containing ${faces.map((f) => f.id).join(" + ")}: ${shot.reason}`, faces.map((f) => f.id), 0.8, "main", a);
        addRun(a, b, "full-crop", [full(id)], `two-shot (${shot.reason.slice(0, 90)})`);
      } else if (shot.kind === "stack") {
        const ordered = [...faces].sort((x, y) => x.box.x - y.box.x).slice(0, 2);
        const halfAspect = W / (H / 2);
        const slots = ordered.map((f, k) => {
          const faceScale = Math.max(1, Math.min(3, cropSize(frame, halfAspect).w / (f.box.w * 4)));
          const box = cropAt(f.box.x + f.box.w / 2, f.eye, frame, { aspect: halfAspect, headroomFrac: opts.headroomFrac, eyeLineFrac: 0.42, scale: faceScale });
          const id = addCrop(box, halfAspect, `stack ${k === 0 ? "top" : "bottom"}: ${f.id}`, [f.id], 0.7, k === 0 ? "top" : "bottom", a);
          return { slot: k === 0 ? "top" : "bottom", cropPathId: id, region: { x: 0, y: k === 0 ? 0 : H / 2, w: W, h: H / 2 }, radius: 0, blurPx: 0, dim: 0 } satisfies LayoutSlot;
        });
        addRun(a, b, "dual-stack", slots, `two people stacked: ${shot.reason.slice(0, 90)}`);
      } else {
        const bg = cropAt(frame.width / 2, frame.height * 0.4, frame, { ...opts });
        const bgId = addCrop(bg, aspect, "backdrop (blurred)", [], 0.5, "bg", a);
        const fitH = Math.round((W * frame.height) / frame.width / 2) * 2;
        const mainId = addCrop({ x: 0, y: 0, w: frame.width, h: frame.height }, frame.width / frame.height, "whole frame (uncertain speaker)", [], 0.5, "main", a);
        addRun(a, b, "fit-background", [
          { slot: "bg", cropPathId: bgId, region: { x: 0, y: 0, w: W, h: H }, radius: 0, blurPx: 40, dim: 0.35 },
          { slot: "main", cropPathId: mainId, region: { x: 0, y: Math.round((H - fitH) / 2), w: W, h: fitH }, radius: 0, blurPx: 0, dim: 0 },
        ], `wide: ${shot.reason.slice(0, 90)}`, ["speaker mapping uncertain"]);
      }
    }
  }
  // Merge adjacent runs that use the same crop geometry (avoid needless joins).
  for (let i = layoutRuns.length - 1; i > 0; i--) {
    const a = layoutRuns[i - 1]!;
    const b = layoutRuns[i]!;
    if (a.outEnd !== b.outStart || a.layout !== b.layout || a.slots.length !== b.slots.length) continue;
    const same = a.slots.every((s, k) => {
      const ca = cropPaths.find((c) => c.id === s.cropPathId)!;
      const cb = cropPaths.find((c) => c.id === b.slots[k]!.cropPathId)!;
      return ca.interpolation === "hold" && cb.interpolation === "hold" && JSON.stringify(ca.keyframes[0]!.box) === JSON.stringify(cb.keyframes[0]!.box);
    });
    if (same && !b.reason.startsWith("jump cut")) {
      a.outEnd = b.outEnd;
      layoutRuns.splice(i, 1);
    }
  }
  const used = new Set(layoutRuns.flatMap((r) => r.slots.map((s) => s.cropPathId)));
  const switches = layoutRuns.filter((r) => r.reason.startsWith("active speaker")).length;
  if (switches) notes.push(`${switches} speaker-framed run(s) from audiovisual evidence; uncertain turns used ${fallbackKind(preset, true)}/${preset.framing.lowConfidenceFallback} layouts`);
  return { layoutRuns, cropPaths: cropPaths.filter((c) => used.has(c.id)), speakers: outSpeakers, notes };
}
