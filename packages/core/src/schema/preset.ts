import { z } from "zod";
import { RationalSchema } from "./common.ts";
import { LayoutKindSchema } from "./editplan.ts";
import { RuleSchema } from "./brief.ts";

const ZoneSchema = z.object({ y0: z.number(), y1: z.number() });

export const FontFaceSchema = z.object({
  family: z.string(),
  /** Path relative to the plugin's assets/fonts directory. */
  file: z.string(),
  weight: z.int(),
  style: z.enum(["normal", "italic"]),
});

export const TextTreatmentSchema = z.object({
  family: z.string(),
  weight: z.int(),
  style: z.enum(["normal", "italic"]).default("normal"),
  sizePx: z.number().positive(),
  color: z.string(),
  stroke: z.object({ color: z.string(), widthPx: z.number().min(0) }).nullable().default(null),
  shadow: z.string().nullable().default(null),
  box: z.object({ color: z.string(), radiusPx: z.number().min(0), padX: z.number().min(0), padY: z.number().min(0) }).nullable().default(null),
  scale: z.number().positive().default(1),
});

export const CaptionStyleSchema = z.object({
  id: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  fonts: z.array(FontFaceSchema),
  base: TextTreatmentSchema.extend({
    lineHeight: z.number().positive().default(1.1),
    letterSpacingEm: z.number().default(0),
    case: z.enum(["as-spoken", "upper", "lower"]).default("as-spoken"),
  }),
  emphasis: z.object({
    /**
     * none: no emphasis; current-word: karaoke-style active word;
     * semantic: meaningful words in any chunk; cadence: after N normal chunks.
     */
    mode: z.enum(["none", "current-word", "semantic", "cadence"]),
    treatment: TextTreatmentSchema.partial().default({}),
    cadence: z.object({ minNormalChunks: z.int().min(1), maxNormalChunks: z.int().min(1), maxWords: z.int().min(1) }).optional(),
    maxWordsPerChunk: z.int().min(0).default(1),
  }),
  grouping: z.object({
    minWords: z.int().min(1),
    maxWords: z.int().min(1),
    maxCharsPerLine: z.int().positive(),
    maxLines: z.int().min(1),
    pauseSplitMs: z.number().positive(),
    minChunkMs: z.number().positive(),
    maxChunkMs: z.number().positive(),
    holdAfterMs: z.number().min(0),
    maxReadingCps: z.number().positive(),
  }),
  placement: z.object({ zone: ZoneSchema, maxWidthPx: z.number().positive(), align: z.enum(["center", "left"]).default("center") }),
  animation: z.object({
    enter: z.enum(["none", "fade", "pop", "rise", "slide"]),
    exit: z.enum(["none", "fade", "cut"]),
    durationMs: z.number().min(0),
    /** 0 = static, 1 = the style's strongest motion; multiplies scale/translate amounts. */
    intensity: z.number().min(0).max(1),
  }),
  emoji: z.boolean().default(false),
  censor: z.enum(["none", "mask-letters", "mask-word"]).default("none"),
});

export const PresetSchema = z.object({
  id: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  output: z.object({
    width: z.int().positive(),
    height: z.int().positive(),
    /** source: match source (capped), fixed: use `fps`. */
    fpsPolicy: z.enum(["source-capped", "fixed"]),
    fps: RationalSchema.optional(),
    maxFps: z.number().positive().default(60),
    crf: z.int().min(0).max(51).default(18),
    x264Preset: z.string().default("medium"),
  }),
  framing: z.object({
    cameraFootageMotion: z.enum(["none", "restrained", "balanced", "energetic"]),
    punchIn: z.object({ min: z.number().min(1), max: z.number().min(1) }).nullable(),
    switching: z.object({
      minHoldMs: z.number().min(0),
      hysteresisMs: z.number().min(0),
      deadZoneFrac: z.number().min(0).max(1),
      maxVelocityFracPerSec: z.number().positive(),
      smoothingMs: z.number().min(0),
      resetAtSceneCuts: z.boolean(),
      minLinkConfidence: z.number().min(0).max(1),
    }),
    headroomFrac: z.number().min(0).max(0.5),
    eyeLineFrac: z.number().min(0).max(1),
    layoutsAllowed: z.array(LayoutKindSchema).min(1),
    defaultLayout: LayoutKindSchema,
    rapidAlternationPolicy: z.enum(["stack", "wide", "switch"]),
    lowConfidenceFallback: z.enum(["fit-background", "dual-stack", "static-center"]),
  }),
  pacing: z.object({
    preRollMs: z.number().min(0),
    postRollMs: z.number().min(0),
    silenceCompress: z.object({ aboveMs: z.number().positive(), toMs: z.number().positive() }).nullable(),
    jCut: z.object({ enabled: z.boolean(), leadMs: z.number().min(0) }),
    tailFadeMaxMs: z.number().min(0),
    maxQuietJoinMs: z.number().min(0),
    keepReactionTails: z.boolean(),
  }),
  captions: z.object({
    defaultStyleId: z.string(),
    allowedStyleIds: z.array(z.string()).min(1),
    zones: z.record(z.string(), ZoneSchema),
    startAfterFirstFrame: z.boolean().default(false),
  }),
  audio: z.object({
    sourceAudioPolicy: z.enum(["voice-only", "keep-source-mix"]),
    voiceChain: z.object({
      highpassHz: z.number().nullable(),
      denoise: z.enum(["off", "light", "medium"]),
      deess: z.boolean(),
      compress: z.boolean(),
    }),
    voiceTargetLufs: z.number(),
    music: z.object({
      mode: z.enum(["none", "synth", "licensed"]),
      targetLufs: z.number().nullable(),
      ducking: z.boolean(),
      bpmRange: z.tuple([z.number(), z.number()]).optional(),
      fadeOutMs: z.number().min(0).default(800),
      declickMs: z.number().min(0).default(5),
    }),
    sfx: z.object({
      enabled: z.boolean(),
      maxWhooshPerRun: z.int().min(0),
      maxWhooshTotal: z.int().min(0),
      relPeakDb: z.record(z.string(), z.number()),
    }),
    riser: z.object({ enabled: z.boolean(), minMs: z.number(), maxMs: z.number(), relPeakDb: z.number() }).nullable(),
    masterTargetLufs: z.number(),
    maxTruePeakDbtp: z.number(),
    toleranceLu: z.number().positive().default(0.5),
  }),
  graphics: z.object({
    enabled: z.boolean(),
    worldCamera: z.boolean(),
    motionBlur: z.object({ enabled: z.boolean(), samplesPerFrame: z.int().min(1), shutter: z.number().min(0).max(1), maxSigmaPx: z.number().min(0) }),
    tokens: z.record(z.string(), z.unknown()).default({}),
  }),
  scoring: z.object({
    weights: z.object({ hook: z.number(), payoff: z.number(), standalone: z.number(), emotion: z.number(), delivery: z.number(), fit: z.number() }),
    penalties: z.record(z.string(), z.number()),
  }),
  selection: z.object({ maxIou: z.number().min(0).max(1), minGapSec: z.number().min(0), durationBand: z.object({ minSec: z.number(), maxSec: z.number() }) }),
  takes: z.object({ policy: z.enum(["none", "last-complete"]), allowEarlierOnDefect: z.boolean() }).default({ policy: "none", allowEarlierOnDefect: false }),
  cover: z.object({ enabled: z.boolean(), style: z.string() }).default({ enabled: true, style: "default" }),
  rules: z.array(RuleSchema).default([]),
});

export type FontFace = z.infer<typeof FontFaceSchema>;
export type TextTreatment = z.infer<typeof TextTreatmentSchema>;
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;
export type Preset = z.infer<typeof PresetSchema>;
