import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EditPlanSchema,
  formatTimecode,
  TimeMap,
  applyEmphasis,
  buildTimeMapPieces,
  computeExtent,
  flicksPerFrame,
  flicksPerSample,
  groupCaptions,
  makeMeasurer,
  msToFlicks,
  quantizeToFrame,
  quantizeToSample,
  rational,
  rationalToNumber,
  retimeWords,
  validatePlan,
  type CaptionStyle,
  type CaptionTrack,
  type CropPath,
  type EditPlan,
  type FaceTrack,
  type Flicks,
  type LayoutRun,
  type MetricsTable,
  type Preset,
  type Rational,
  type SourceAsset,
  type TimelineSegment,
  type Transcript,
  type VisualAnalysis,
  type Word,
} from "../../../core/src/index.ts";
import { paths } from "../../../adapters/src/env.ts";
import { endsSentence } from "../../../core/src/index.ts";
import { planFraming } from "./framing.ts";
import { wordSpacingPx } from "../../../adapters/src/render/captions.ts";

export interface ClipPlanInput {
  projectId: string;
  clipId: string;
  source: SourceAsset;
  transcript: Transcript;
  visual: VisualAnalysis | null;
  preset: Preset;
  style: CaptionStyle;
  /** Requested source range (seconds-based flicks); refined to word boundaries. */
  range: { start: Flicks; end: Flicks };
  candidateId?: string;
  title?: string;
  keywords?: string[];
  /** Source-time speech regions (VAD) for active-speaker detection. */
  speech?: Array<{ start: Flicks; end: Flicks }>;
  decisions?: EditPlan["decisions"];
}

export interface ClipPlanResult {
  plan: EditPlan;
  notes: string[];
}

function outputFps(preset: Preset, source: SourceAsset): Rational {
  if (preset.output.fpsPolicy === "fixed" && preset.output.fps) return preset.output.fps;
  const src = source.probe.video?.fps ?? rational(30);
  const v = rationalToNumber(src);
  if (v > preset.output.maxFps + 0.01) return rational(Math.round(preset.output.maxFps));
  // Keep NTSC rationals exact; snap near-integer rates.
  if (Math.abs(v - Math.round(v)) < 0.01) return rational(Math.round(v));
  return src;
}

/** Words fully inside [start, end). */
function wordsIn(words: readonly Word[], start: Flicks, end: Flicks): Word[] {
  return words.filter((w) => w.start >= start && w.end <= end);
}

/**
 * Refines a rough range to an intelligible opening and a complete ending:
 * starts just before the first whole word, ends after the last whole word.
 */
export function refineRange(
  words: readonly Word[],
  start: Flicks,
  end: Flicks,
  preRoll: Flicks,
  postRoll: Flicks,
  opts: { extendEndMs?: number; extendStartMs?: number } = {},
): { start: Flicks; end: Flicks; first: Word; last: Word; adjustments: string[] } {
  const adjustments: string[] = [];
  const inside = words.filter((w) => w.end > start && w.start < end);
  if (inside.length === 0) throw new Error("no transcribed speech inside the requested range");
  // Drop a word cut by a boundary unless it is mostly inside.
  let first = inside[0]!;
  if (first.start < start && (start - first.start) / (first.end - first.start) > 0.5 && inside[1]) first = inside[1];
  let last = inside[inside.length - 1]!;
  if (last.end > end && (last.end - end) / (last.end - last.start) > 0.5 && inside.length > 1) last = inside[inside.length - 2]!;
  // Sentence-aware snapping: finish the sentence (payoff) and start at a sentence opening.
  const maxEnd = msToFlicks(opts.extendEndMs ?? 3000);
  if (!endsSentence(last.text)) {
    let k = words.indexOf(last);
    while (k + 1 < words.length && words[k + 1]!.end - last.end <= maxEnd && !endsSentence(words[k]!.text)) k++;
    if (endsSentence(words[k]!.text) && words[k] !== last) {
      adjustments.push(`extended end by ${((words[k]!.end - last.end) / 705_600).toFixed(0)} ms to finish the sentence ("…${words[k]!.text}")`);
      last = words[k]!;
    } else if (!endsSentence(last.text)) adjustments.push(`ends mid-sentence at "${last.text}" (no sentence end within ${(maxEnd / 705_600).toFixed(0)} ms)`);
  }
  const maxStart = msToFlicks(opts.extendStartMs ?? 2000);
  const prevOf = (w: Word) => words[words.indexOf(w) - 1];
  const OPENERS = new Set(["and", "so", "but", "um", "uh", "well", "okay", "ok", "yeah", "now", "like"]);
  const opensSentence = (w: Word) => {
    // A sentence opening, or the first content word after a trimmed spoken opener ("And", "So").
    let k = words.indexOf(w) - 1;
    while (k >= 0 && OPENERS.has(words[k]!.text.toLowerCase().replace(/[^a-z']/g, ""))) k--;
    const prev = k >= 0 ? words[k] : undefined;
    const direct = prevOf(w);
    return !direct || !prev || endsSentence(prev.text) || w.start - direct.end > msToFlicks(700) || (k < words.indexOf(w) - 1 && (k < 0 || endsSentence(words[k]!.text) || words[k + 1]!.start - words[k]!.end > msToFlicks(700)));
  };
  if (!opensSentence(first)) {
    let k = words.indexOf(first);
    while (k > 0 && first.start - words[k - 1]!.start <= maxStart && !opensSentence(words[k]!)) k--;
    if (opensSentence(words[k]!) && words[k] !== first) {
      adjustments.push(`moved start back ${((first.start - words[k]!.start) / 705_600).toFixed(0)} ms to the sentence opening ("${words[k]!.text}…")`);
      first = words[k]!;
    } else adjustments.push(`starts mid-sentence at "${first.text}"`);
  }
  const prev = prevOf(first);
  const next = words[words.indexOf(last) + 1];
  const s = Math.max(prev ? prev.end : 0, first.start - preRoll, 0);
  const e = Math.min(next ? next.start : Number.MAX_SAFE_INTEGER, last.end + postRoll);
  return { start: s, end: e, first, last, adjustments };
}

/** Splits [start,end) into spoken spans, shortening pauses longer than `aboveMs` to `toMs`. */
export function speechSpans(words: readonly Word[], start: Flicks, end: Flicks, compress: { aboveMs: number; toMs: number } | null): Array<{ start: Flicks; end: Flicks }> {
  if (!compress) return [{ start, end }];
  const ws = wordsIn(words, start, end);
  const spans: Array<{ start: Flicks; end: Flicks }> = [];
  let spanStart = start;
  for (let i = 0; i < ws.length - 1; i++) {
    const gap = ws[i + 1]!.start - ws[i]!.end;
    if (gap > msToFlicks(compress.aboveMs)) {
      const keep = msToFlicks(compress.toMs) / 2;
      spans.push({ start: spanStart, end: ws[i]!.end + keep });
      spanStart = ws[i + 1]!.start - keep;
    }
  }
  spans.push({ start: spanStart, end });
  return spans.filter((s) => s.end > s.start);
}

/** Dominant face in a time window: the speaker-linked track if any, else the most visible. */
function dominantFace(visual: VisualAnalysis | null, start: Flicks, end: Flicks): { track: FaceTrack; reason: string; confidence: number } | null {
  if (!visual) return null;
  const overlapping = visual.faceTracks
    .map((t) => {
      const samples = t.samples.filter((s) => s.t >= start && s.t < end);
      return { t, n: samples.length };
    })
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  if (overlapping.length === 0) return null;
  const linked = overlapping.find((o) => visual.speakerLinks.some((l) => l.trackId === o.t.id && l.confidence >= 0.6));
  if (linked) return { track: linked.t, reason: `speaker-linked face ${linked.t.id}`, confidence: 0.75 };
  const best = overlapping[0]!;
  return { track: best.t, reason: `most visible face ${best.t.id} (${best.n} samples)`, confidence: overlapping.length === 1 ? 0.7 : 0.45 };
}

/** Static 9:16 crop centred on a face (median position), respecting headroom and bounds. */
export function staticFaceCrop(srcW: number, srcH: number, aspect: number, track: FaceTrack | null, start: Flicks, end: Flicks, headroomFrac: number, eyeLineFrac: number, scale = 1): { box: { x: number; y: number; w: number; h: number }; reason: string } {
  let h = srcH;
  let w = h * aspect;
  if (w > srcW) {
    w = srcW;
    h = w / aspect;
  }
  w /= scale;
  h /= scale;
  let cx = srcW / 2;
  let cy = srcH / 2;
  let reason = "no face in range: centred crop";
  if (track) {
    const samples = track.samples.filter((s) => s.t >= start && s.t < end);
    const xs = samples.map((s) => s.box.x + s.box.w / 2).sort((a, b) => a - b);
    const eyes = samples.map((s) => (s.landmarks ? (s.landmarks[1]! + s.landmarks[3]!) / 2 : s.box.y + s.box.h * 0.4)).sort((a, b) => a - b);
    if (xs.length > 0) {
      cx = xs[Math.floor(xs.length / 2)]!;
      const eyeY = eyes[Math.floor(eyes.length / 2)]!;
      cy = eyeY + h * (0.5 - eyeLineFrac);
      const topOfHead = Math.min(...samples.map((s) => s.box.y)) - samples[0]!.box.h * 0.25;
      const minTop = topOfHead - h * headroomFrac;
      reason = `static crop on ${track.id}: median face centre x=${cx.toFixed(0)}, eye line at ${(eyeLineFrac * 100).toFixed(0)}% of frame height`;
      if (cy - h / 2 > minTop && minTop >= 0) cy = minTop + h / 2;
    }
  }
  const x = Math.min(Math.max(cx - w / 2, 0), srcW - w);
  const y = Math.min(Math.max(cy - h / 2, 0), srcH - h);
  return { box: { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, w: Math.round(w * 1000) / 1000, h: Math.round(h * 1000) / 1000 }, reason };
}

export function buildClipPlan(input: ClipPlanInput): ClipPlanResult {
  const { source, transcript, preset, style, visual } = input;
  const notes: string[] = [];
  const fps = outputFps(preset, source);
  const frame = flicksPerFrame(fps);
  const sr = 48_000;
  const sample = flicksPerSample(sr);
  const pre = msToFlicks(preset.pacing.preRollMs);
  const post = msToFlicks(preset.pacing.postRollMs);
  const refined = refineRange(transcript.words, input.range.start, input.range.end, pre, post);
  notes.push(`range refined to whole words: "${refined.first.text}" … "${refined.last.text}"`);
  notes.push(...refined.adjustments);
  const spans = speechSpans(transcript.words, refined.start, refined.end, preset.pacing.silenceCompress);
  if (spans.length > 1) notes.push(`compressed ${spans.length - 1} pause(s) longer than ${preset.pacing.silenceCompress!.aboveMs} ms to ${preset.pacing.silenceCompress!.toMs} ms`);

  // Picture cuts on the frame grid; audio clips sample-aligned with short declick fades.
  const segments: TimelineSegment[] = [];
  let out = 0;
  const declick = quantizeToSample(msToFlicks(8), sr);
  const audioSource = source.derived.audio48k;
  if (!audioSource) throw new Error(`${source.id} has no 48 kHz audio track`);
  spans.forEach((span, i) => {
    const srcStart = quantizeToFrame(span.start, fps, "floor");
    const durRaw = span.end - srcStart;
    const dur = Math.max(frame, quantizeToFrame(durRaw, fps, "ceil"));
    const segId = `seg${String(i + 1).padStart(3, "0")}`;
    const aSrc = quantizeToSample(srcStart, sr, "round");
    segments.push({
      id: segId,
      picture: { sourceId: source.id, srcStart, outStart: out, outEnd: out + dur, rate: { num: 1, den: 1 } },
      audio: [
        {
          id: "a1",
          sourceId: source.id,
          srcStart: aSrc,
          outStart: quantizeToSample(out, sr),
          outEnd: quantizeToSample(out + dur, sr),
          fadeInFlicks: i === 0 ? 0 : declick,
          fadeOutFlicks: i === spans.length - 1 ? 0 : declick,
          gainDb: 0,
          role: preset.audio.sourceAudioPolicy === "voice-only" ? "voice" : "source-mix",
        },
      ],
      wordIds: wordsIn(transcript.words, span.start, span.end).map((w) => w.id),
    });
    out += dur;
  });
  // Audio srcStart must keep lip sync with picture: same offset as picture (out - src).
  for (const seg of segments) {
    const a = seg.audio[0]!;
    a.srcStart = a.outStart - (seg.picture.outStart - seg.picture.srcStart);
    if (a.srcStart < 0) {
      const shift = -a.srcStart;
      a.srcStart = 0;
      a.outStart += Math.ceil(shift / sample) * sample;
    }
  }
  const extent = computeExtent(segments, fps);
  // Final picture segment must reach END exactly.
  const lastSeg = segments[segments.length - 1]!;
  lastSeg.picture.outEnd = extent.end;

  // Layout: one stable full-crop per source scene inside the clip.
  const srcW = source.probe.video?.displayWidth ?? 1920;
  const srcH = source.probe.video?.displayHeight ?? 1080;
  const aspect = preset.output.width / preset.output.height;
  const map = new TimeMap(buildTimeMapPieces(segments));
  const sceneCutsOut = new Set<number>();
  for (const sc of visual?.scenes ?? []) {
    for (const t of map.srcToOut("video", source.id, sc.start)) {
      const q = quantizeToFrame(t, fps, "round");
      if (q > 0 && q < extent.end) sceneCutsOut.add(q);
    }
  }
  // Jump cuts (picture cuts inside one source scene) are masked with an alternating
  // punch-in when the preset allows footage motion; real scene cuts reset framing.
  const masking = preset.framing.punchIn !== null && preset.framing.cameraFootageMotion !== "none";
  const punch = masking ? Math.min(preset.framing.punchIn!.max, Math.max(preset.framing.punchIn!.min, 1.06)) : 1;
  const jumpCuts = new Set(masking ? segments.slice(1).map((sg) => sg.picture.outStart).filter((c) => !sceneCutsOut.has(c)) : []);
  const boundaries = [...new Set([0, ...sceneCutsOut, ...jumpCuts, extent.end])].sort((a, b) => a - b);
  const cropPaths: CropPath[] = [];
  const layoutRuns: LayoutRun[] = [];
  const zone = preset.captions.zones["full-crop"] ?? style.placement.zone;
  let parity = 0;
  const runSpans: Array<{ start: Flicks; end: Flicks; punchIn: number; reason: string }> = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const a = boundaries[i]!;
    const b = boundaries[i + 1]!;
    if (jumpCuts.has(a)) parity = 1 - parity;
    else if (sceneCutsOut.has(a)) parity = 0;
    const scale = parity ? punch : 1;
    runSpans.push({ start: a, end: b, punchIn: scale, reason: i === 0 ? "opening" : jumpCuts.has(a) ? `jump cut (pause removed): framing alternates to ${scale.toFixed(2)}×` : "new source scene" });
  }
  const audioFeatures = input.speech ?? [];
  const framing = planFraming({
    preset,
    sourceId: source.id,
    frame: { width: srcW, height: srcH },
    canvas: { width: preset.output.width, height: preset.output.height },
    fps,
    map,
    tracks: visual?.faceTracks ?? [],
    speech: audioFeatures,
    spans: runSpans,
  });
  cropPaths.push(...framing.cropPaths);
  layoutRuns.push(...framing.layoutRuns);
  notes.push(...framing.notes);
  for (const run of layoutRuns) {
    for (const slot of run.slots) {
      const c = cropPaths.find((x) => x.id === slot.cropPathId);
      if (!c || slot.blurPx > 0) continue;
      const upscale = slot.region.w / c.keyframes[0]!.box.w;
      if (upscale > 2) run.exceptions.push(`source resolution limits sharpness: ${c.keyframes[0]!.box.w.toFixed(0)} px → ${slot.region.w} px (${upscale.toFixed(2)}× upscale)`);
    }
  }
  if (layoutRuns.some((r) => r.exceptions.some((e) => e.startsWith("source resolution")))) notes.push(`source is ${srcW}x${srcH}: some crops are upscaled more than 2× — sharpness is limited by the source resolution`);
  void zone;
  void dominantFace;

  // Captions from the final timeline.
  const metrics = JSON.parse(readFileSync(join(paths().fontsDir, "metrics.json"), "utf8")) as MetricsTable;
  const measure = makeMeasurer(metrics, {
    family: style.base.family,
    weight: style.base.weight,
    style: style.base.style,
    sizePx: style.base.sizePx,
    letterSpacingEm: style.base.letterSpacingEm,
    strokePx: style.base.stroke?.widthPx ?? 0,
    upper: style.base.case === "upper",
    wordSpacingPx: wordSpacingPx(style),
  });
  const retimed = retimeWords(transcript.words, map, source.id);
  if (retimed.dropped.some((d) => d.reason === "mostly-cut")) notes.push(`${retimed.dropped.filter((d) => d.reason === "mostly-cut").length} word(s) cut at boundaries were left out of captions`);
  const minStart = preset.captions.startAfterFirstFrame ? frame : 0;
  const grouped = groupCaptions(retimed.words, style.grouping, {
    fps,
    minStart,
    end: extent.end,
    measure,
    maxWidthPx: style.placement.maxWidthPx,
    caseMode: style.base.case,
    keepTogether: input.keywords ?? [],
  });
  for (const issue of grouped.issues) if (issue.kind !== "clamped-start") notes.push(`captions: ${issue.kind} ${issue.chunkId} — ${issue.detail}`);
  const emph = applyEmphasis(grouped.chunks, {
    mode: style.emphasis.mode,
    maxWordsPerChunk: style.emphasis.maxWordsPerChunk,
    ...(style.emphasis.cadence ? { cadence: style.emphasis.cadence } : {}),
    keywords: input.keywords ?? [],
  });
  const captions: CaptionTrack = {
    styleId: style.id,
    styleVersion: style.version,
    overrides: {},
    language: transcript.language,
    chunks: emph.chunks,
    delivery: { burnIn: true, srt: true, vtt: true, wordsJson: true },
    minStartFlicks: minStart,
    notes: emph.decisions.map((d) => `emphasis ${d.chunkId}: ${d.reason}`),
  };

  const plan: EditPlan = EditPlanSchema.parse({
    schemaVersion: 1,
    projectId: input.projectId,
    clipId: input.clipId,
    version: 1,
    parentVersion: null,
    createdAt: new Date().toISOString(),
    createdBy: "planner",
    changeSummary: `initial plan from ${input.candidateId ?? "manual range"}`,
    changes: [],
    presetId: preset.id,
    presetVersion: preset.version,
    briefVersion: null,
    ...(input.candidateId ? { candidateId: input.candidateId } : {}),
    sourceRange: { sourceId: source.id, start: refined.start, end: refined.end },
    output: {
      width: preset.output.width,
      height: preset.output.height,
      fps,
      sampleRate: sr,
      audioChannels: 2,
      durationFlicks: extent.end,
      voiceEndFlicks: extent.voiceEnd,
      frameCount: extent.frameCount,
      video: { codec: "h264", pixFmt: "yuv420p", crf: preset.output.crf, preset: preset.output.x264Preset, profile: "high" },
      audio: { codec: "aac", bitrateKbps: 192 },
    },
    sources: [{ sourceId: source.id, role: "primary", clock: null }],
    segments,
    timeMap: buildTimeMapPieces(segments),
    layoutRuns,
    cropPaths,
    captions,
    titleOverlays: [],
    graphics: [],
    audio: {
      sourceAudioPolicy: preset.audio.sourceAudioPolicy,
      voice: { sourceId: source.id, chain: { ...preset.audio.voiceChain, targetLufs: preset.audio.voiceTargetLufs } },
      music: { mode: "none", seed: 1, bpm: 110, key: "C", targetLufs: null, fadeOutFlicks: 0, declickFlicks: 0, ducking: false, gainDb: 0, params: {} },
      sfx: [],
      riser: null,
      master: { targetLufs: preset.audio.masterTargetLufs, maxTruePeakDbtp: preset.audio.maxTruePeakDbtp, limiter: "if-needed" },
    },
    cover: input.title ? { title: input.title, titleSource: "hook", frameZero: false, style: preset.cover.style, exportImage: true } : null,
    cta: null,
    takes: [],
    decisions: input.decisions ?? [],
    fallbacks: cropPaths.some((c) => c.trackIds.length === 0) ? [{ capability: "face framing", reason: "no face detected in at least one run", fallback: "centred static crop" }] : [],
    locks: [],
  });
  const issues = validatePlan(plan, {
    sourceFrames: new Map([[source.id, { width: srcW, height: srcH, durationFlicks: source.probe.durationFlicks }]]),
    sourceWordIds: new Set(transcript.words.map((w) => w.id)),
  });
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) throw new Error(`planner produced an invalid plan:\n${errors.map((e) => `  ${e.code}: ${e.message}`).join("\n")}`);
  for (const w of issues.filter((i) => i.severity === "warning")) notes.push(`plan warning ${w.code}: ${w.message}`);
  return { plan, notes };
}
