import { z } from "zod";
import {
  BoxSchema,
  ConfidenceSchema,
  FlicksSchema,
  IdSchema,
  IsoDateSchema,
  NonNegFlicksSchema,
  RationalSchema,
} from "./common.ts";

/** Canvas-space rectangle (output pixels). */
export const RegionSchema = z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() });

export const OutputSpecSchema = z.object({
  width: z.int().positive(),
  height: z.int().positive(),
  fps: RationalSchema,
  sampleRate: z.int().positive(),
  audioChannels: z.int().positive(),
  /** END: frame-aligned output duration shared by every layer and stem. */
  durationFlicks: NonNegFlicksSchema,
  /** Exact end of the last meaningful voice sample (sample-aligned, <= END). */
  voiceEndFlicks: NonNegFlicksSchema,
  frameCount: z.int().positive(),
  video: z.object({ codec: z.literal("h264"), pixFmt: z.string(), crf: z.int(), preset: z.string(), profile: z.string() }),
  audio: z.object({ codec: z.literal("aac"), bitrateKbps: z.int().positive() }),
});

/**
 * Clock alignment of a secondary recording (e.g. clean mic) to a reference
 * (camera): srcTime = refTime + offset + driftPpm * 1e-6 * (refTime - anchor).
 */
export const SourceClockSchema = z.object({
  refSourceId: IdSchema,
  offsetFlicks: FlicksSchema,
  driftPpm: z.number().default(0),
  anchorFlicks: FlicksSchema.default(0),
  confidence: ConfidenceSchema,
  method: z.string(),
  evidence: z.string(),
});

export const PlanSourceSchema = z.object({
  sourceId: IdSchema,
  role: z.enum(["primary", "camera", "mic", "screen", "broll"]),
  clock: SourceClockSchema.nullable().default(null),
});

export const PictureSchema = z.object({
  sourceId: IdSchema,
  srcStart: NonNegFlicksSchema,
  outStart: NonNegFlicksSchema,
  outEnd: NonNegFlicksSchema,
  rate: RationalSchema.default({ num: 1, den: 1 }),
});

export const AudioClipSchema = z.object({
  id: IdSchema,
  sourceId: IdSchema,
  srcStart: NonNegFlicksSchema,
  outStart: NonNegFlicksSchema,
  outEnd: NonNegFlicksSchema,
  fadeInFlicks: NonNegFlicksSchema.default(0),
  fadeOutFlicks: NonNegFlicksSchema.default(0),
  gainDb: z.number().default(0),
  role: z.enum(["voice", "ambient", "reaction", "source-mix"]).default("voice"),
});

export const TimelineSegmentSchema = z.object({
  id: IdSchema,
  picture: PictureSchema,
  audio: z.array(AudioClipSchema),
  takeId: IdSchema.optional(),
  lineId: IdSchema.optional(),
  /** Source word ids whose audio is presented by this segment. */
  wordIds: z.array(IdSchema).default([]),
  note: z.string().optional(),
});

export const TimeMapPieceSchema = z.object({
  id: IdSchema,
  track: z.enum(["video", "audio"]),
  segmentId: IdSchema,
  sourceId: IdSchema,
  outStart: NonNegFlicksSchema,
  outEnd: NonNegFlicksSchema,
  srcStart: FlicksSchema,
  rate: RationalSchema,
});

export const CropKeyframeSchema = z.object({
  /** Output time. */
  t: NonNegFlicksSchema,
  /** Crop window in source pixels. */
  box: BoxSchema,
  hold: z.boolean().default(false),
});

export const CropPathSchema = z.object({
  id: IdSchema,
  sourceId: IdSchema,
  slot: z.string(),
  /** Target region aspect (w/h) that every keyframe box must match. */
  aspect: z.number().positive(),
  keyframes: z.array(CropKeyframeSchema).min(1),
  interpolation: z.enum(["hold", "linear", "smooth"]),
  trackIds: z.array(z.string()).default([]),
  reason: z.string(),
  confidence: ConfidenceSchema,
  manual: z.boolean().default(false),
});

export const LayoutKindSchema = z.enum([
  "full-crop",
  "fit-background",
  "speaker-split",
  "dual-stack",
  "screen-face",
  "lt-full-camera",
  "lt-split",
  "lt-full-visual",
]);

export const LayoutSlotSchema = z.object({
  slot: z.string(),
  cropPathId: IdSchema,
  region: RegionSchema,
  radius: z.number().min(0).default(0),
  /** Gaussian blur (output px) — e.g. the backdrop of a fit-background layout. */
  blurPx: z.number().min(0).default(0),
  /** Darken 0..1 (backdrop separation). */
  dim: z.number().min(0).max(1).default(0),
  /** Rounded-rect window (canvas coords, may bleed off-canvas) that reveals this slot — e.g. the Luxury camera card. */
  mask: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(), radius: z.number().min(0) }).optional(),
  /**
   * Matted-person layer: shows only the segmented person from the same source frame and
   * transform as the slot named in `alignedWith`, fading out over `featherPx` centred on `featherY`.
   */
  matte: z.object({ alignedWith: z.string(), featherY: z.number(), featherPx: z.number().min(0), engine: z.string() }).optional(),
});

export const LayoutRunSchema = z.object({
  id: IdSchema,
  outStart: NonNegFlicksSchema,
  outEnd: NonNegFlicksSchema,
  layout: LayoutKindSchema,
  slots: z.array(LayoutSlotSchema).default([]),
  graphicId: IdSchema.optional(),
  captionZone: z.object({ y0: z.number(), y1: z.number() }),
  speakerId: z.string().optional(),
  reason: z.string(),
  eventIds: z.array(IdSchema).default([]),
  exceptions: z.array(z.string()).default([]),
});

export const CaptionWordSchema = z.object({
  /** Final-timeline word id, e.g. "fw0001". */
  id: IdSchema,
  sourceWordId: IdSchema,
  text: z.string(),
  /** Display form after approved corrections / casing. */
  display: z.string(),
  outStart: NonNegFlicksSchema,
  outEnd: NonNegFlicksSchema,
  emphasis: z.enum(["none", "accent", "highlight"]).default("none"),
  uncertain: z.boolean().default(false),
  corrected: z.object({ from: z.string(), reason: z.string() }).optional(),
});

export const CaptionChunkSchema = z.object({
  id: IdSchema,
  outStart: NonNegFlicksSchema,
  outEnd: NonNegFlicksSchema,
  words: z.array(CaptionWordSchema).min(1),
  /** Word ids per rendered line. */
  lines: z.array(z.array(IdSchema)).min(1),
  zoneOverride: z.object({ y0: z.number(), y1: z.number(), reason: z.string() }).optional(),
});

export const CaptionTrackSchema = z.object({
  styleId: z.string(),
  styleVersion: z.string(),
  overrides: z.record(z.string(), z.unknown()).default({}),
  language: z.string(),
  chunks: z.array(CaptionChunkSchema),
  delivery: z.object({ burnIn: z.boolean(), srt: z.boolean(), vtt: z.boolean(), wordsJson: z.boolean() }),
  /** Earliest allowed caption time (e.g. first frame after the cover frame). */
  minStartFlicks: NonNegFlicksSchema.default(0),
  notes: z.array(z.string()).default([]),
});

/** Authored text (titles, hooks, labels) — never presented as spoken words. */
export const TitleOverlaySchema = z.object({
  id: IdSchema,
  kind: z.enum(["cover-title", "hook-title", "label", "annotation"]),
  text: z.string(),
  outStart: NonNegFlicksSchema,
  outEnd: NonNegFlicksSchema,
  region: RegionSchema.optional(),
});

export const GraphicEventSchema = z.object({
  id: IdSchema,
  t: NonNegFlicksSchema,
  kind: z.enum(["type", "click", "response", "stream", "modal", "land", "whip", "push", "pull", "step", "glide", "logo", "caret", "reveal", "other"]),
  durationFlicks: NonNegFlicksSchema.default(0),
  target: z.string().optional(),
  detail: z.string().optional(),
});

export const CameraMoveSchema = z.object({
  t: NonNegFlicksSchema,
  kind: z.enum(["hold", "glide", "step", "push", "pull", "whip", "inner-zoom"]),
  durationFlicks: NonNegFlicksSchema,
  ease: z.string(),
  scale: z.number().positive().optional(),
  target: z.string().optional(),
  /** For whips: the midpoint used to align the whoosh peak. */
  midpointFlicks: NonNegFlicksSchema.optional(),
});

export const GraphicSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  template: z.string(),
  subject: z.string(),
  props: z.record(z.string(), z.unknown()).default({}),
  events: z.array(GraphicEventSchema).default([]),
  camera: z.array(CameraMoveSchema).default([]),
  sources: z
    .array(
      z.object({
        url: z.string(),
        kind: z.enum(["capture", "official-asset", "reconstruction", "generated"]),
        disclosed: z.boolean(),
        note: z.string().optional(),
      }),
    )
    .default([]),
  motionBlur: z.object({ enabled: z.boolean(), samplesPerFrame: z.int().min(1), shutter: z.number().min(0).max(1) }).optional(),
});

export const SoundEventKindSchema = z.enum(["click", "tick", "pop", "chime", "whoosh", "riser"]);

export const SoundEventSchema = z.object({
  id: IdSchema,
  /** Output time of the sound's anchor (onset for clicks, peak for whooshes). */
  t: NonNegFlicksSchema,
  kind: SoundEventKindSchema,
  variant: z.int().min(0),
  /** Peak relative to the voice-stem peak, dB. */
  relPeakDb: z.number(),
  linkedEventId: IdSchema.optional(),
  runId: IdSchema.optional(),
  reason: z.string(),
});

export const AudioPlanSchema = z.object({
  sourceAudioPolicy: z.enum(["voice-only", "keep-source-mix"]),
  voice: z.object({
    sourceId: IdSchema,
    chain: z.object({
      highpassHz: z.number().nullable(),
      denoise: z.enum(["off", "light", "medium"]),
      deess: z.boolean(),
      compress: z.boolean(),
      targetLufs: z.number().nullable(),
    }),
  }),
  music: z.object({
    mode: z.enum(["none", "synth", "licensed"]),
    seed: z.int(),
    bpm: z.number().positive(),
    key: z.string(),
    targetLufs: z.number().nullable(),
    fadeOutFlicks: NonNegFlicksSchema,
    declickFlicks: NonNegFlicksSchema,
    ducking: z.boolean(),
    gainDb: z.number().default(0),
    licensedPath: z.string().optional(),
    params: z.record(z.string(), z.unknown()).default({}),
  }),
  sfx: z.array(SoundEventSchema).default([]),
  riser: z
    .object({ enabled: z.boolean(), endFlicks: NonNegFlicksSchema, durationFlicks: NonNegFlicksSchema, relPeakDb: z.number() })
    .nullable()
    .default(null),
  master: z.object({
    targetLufs: z.number(),
    maxTruePeakDbtp: z.number(),
    limiter: z.enum(["off", "if-needed"]),
    /** Extra pre-encode headroom for AAC inter-sample overs (repair passes may raise it). */
    aacHeadroomDb: z.number().min(0).max(3).optional(),
  }),
});

export const CoverSchema = z.object({
  title: z.string(),
  titleSource: z.enum(["user", "hook", "none"]),
  frameZero: z.boolean(),
  style: z.string(),
  exportImage: z.boolean().default(true),
});

export const CtaSchema = z.object({
  keyword: z.string(),
  requestedBy: z.enum(["speech", "brief", "user"]),
  spoken: z.object({ start: NonNegFlicksSchema, end: NonNegFlicksSchema }).nullable(),
  composition: z.string(),
  box: RegionSchema,
  /** Output-time schedule: box appears, keyword types, Post is pressed; everything ends at END. */
  showFlicks: NonNegFlicksSchema.optional(),
  typeAtFlicks: NonNegFlicksSchema.optional(),
  postAtFlicks: NonNegFlicksSchema.optional(),
});

export const TakeChoiceSchema = z.object({
  lineId: IdSchema,
  chosenTakeId: IdSchema,
  takes: z.array(
    z.object({
      id: IdSchema,
      start: NonNegFlicksSchema,
      end: NonNegFlicksSchema,
      text: z.string(),
      complete: z.boolean(),
      defects: z.array(z.string()).default([]),
    }),
  ),
  reason: z.string(),
  swappedFromLast: z.boolean(),
});

export const PlanDecisionSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  layer: z.enum(["user", "project", "preset", "brief", "default", "fallback"]),
  reason: z.string(),
});

export const PlanLockSchema = z.object({
  kind: z.enum(["segment", "run", "chunk", "graphic", "range"]),
  id: IdSchema.optional(),
  start: NonNegFlicksSchema.optional(),
  end: NonNegFlicksSchema.optional(),
  reason: z.string(),
});

export const EditPlanSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: IdSchema,
  clipId: IdSchema,
  version: z.int().positive(),
  parentVersion: z.int().positive().nullable(),
  createdAt: IsoDateSchema,
  createdBy: z.enum(["planner", "user-revision", "repair", "director", "creator-edit"]),
  changeSummary: z.string(),
  changes: z
    .array(z.object({ path: z.string(), op: z.string(), reason: z.string(), evidence: z.string().optional() }))
    .default([]),
  presetId: z.string(),
  presetVersion: z.string(),
  briefVersion: z.string().nullable().default(null),
  candidateId: IdSchema.optional(),
  sourceRange: z.object({ sourceId: IdSchema, start: NonNegFlicksSchema, end: NonNegFlicksSchema }).optional(),
  output: OutputSpecSchema,
  sources: z.array(PlanSourceSchema).min(1),
  segments: z.array(TimelineSegmentSchema).min(1),
  timeMap: z.array(TimeMapPieceSchema),
  layoutRuns: z.array(LayoutRunSchema).min(1),
  cropPaths: z.array(CropPathSchema).default([]),
  captions: CaptionTrackSchema.nullable(),
  titleOverlays: z.array(TitleOverlaySchema).default([]),
  graphics: z.array(GraphicSchema).default([]),
  audio: AudioPlanSchema,
  cover: CoverSchema.nullable().default(null),
  cta: CtaSchema.nullable().default(null),
  takes: z.array(TakeChoiceSchema).default([]),
  decisions: z.array(PlanDecisionSchema).default([]),
  fallbacks: z.array(z.object({ capability: z.string(), reason: z.string(), fallback: z.string() })).default([]),
  locks: z.array(PlanLockSchema).default([]),
});

export type Region = z.infer<typeof RegionSchema>;
export type OutputSpec = z.infer<typeof OutputSpecSchema>;
export type SourceClock = z.infer<typeof SourceClockSchema>;
export type PlanSource = z.infer<typeof PlanSourceSchema>;
export type AudioClip = z.infer<typeof AudioClipSchema>;
export type TimelineSegment = z.infer<typeof TimelineSegmentSchema>;
export type CropKeyframe = z.infer<typeof CropKeyframeSchema>;
export type CropPath = z.infer<typeof CropPathSchema>;
export type LayoutKind = z.infer<typeof LayoutKindSchema>;
export type LayoutRun = z.infer<typeof LayoutRunSchema>;
export type LayoutSlot = z.infer<typeof LayoutSlotSchema>;
export type CaptionWord = z.infer<typeof CaptionWordSchema>;
export type CaptionChunk = z.infer<typeof CaptionChunkSchema>;
export type CaptionTrack = z.infer<typeof CaptionTrackSchema>;
export type TitleOverlay = z.infer<typeof TitleOverlaySchema>;
export type GraphicEvent = z.infer<typeof GraphicEventSchema>;
export type CameraMove = z.infer<typeof CameraMoveSchema>;
export type Graphic = z.infer<typeof GraphicSchema>;
export type SoundEvent = z.infer<typeof SoundEventSchema>;
export type AudioPlan = z.infer<typeof AudioPlanSchema>;
export type Cover = z.infer<typeof CoverSchema>;
export type Cta = z.infer<typeof CtaSchema>;
export type TakeChoice = z.infer<typeof TakeChoiceSchema>;
export type PlanDecision = z.infer<typeof PlanDecisionSchema>;
export type EditPlan = z.infer<typeof EditPlanSchema>;
