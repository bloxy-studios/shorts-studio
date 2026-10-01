import { z } from "zod";
import { BoxSchema, ConfidenceSchema, FlicksSchema, IdSchema, IntervalSchema, IsoDateSchema, NonNegFlicksSchema } from "./common.ts";

export const SceneSchema = z.object({
  id: IdSchema,
  start: NonNegFlicksSchema,
  end: NonNegFlicksSchema,
  /** Detector score at the cut that opens this scene (0 for the first scene). */
  cutScore: z.number().min(0).default(0),
});

export const FaceSampleSchema = z.object({
  t: NonNegFlicksSchema,
  box: BoxSchema,
  score: ConfidenceSchema,
  /** 5-point landmarks [rx, ry, lx, ly, nx, ny, mrx, mry, mlx, mly] in source pixels. */
  landmarks: z.array(z.number()).length(10).optional(),
  yawDeg: z.number().optional(),
  pitchDeg: z.number().optional(),
  lookingAtLens: z.object({ value: z.boolean(), confidence: ConfidenceSchema }).optional(),
  mouthActivity: z.number().optional(),
});

export const FaceTrackSchema = z.object({
  id: IdSchema,
  sceneId: IdSchema.optional(),
  start: NonNegFlicksSchema,
  end: NonNegFlicksSchema,
  samples: z.array(FaceSampleSchema),
  meanBox: BoxSchema,
  identityId: z.string().optional(),
  /** Fraction of sampled frames in [start,end) where the face was detected. */
  visibility: ConfidenceSchema,
});

export const SpeakerLinkSchema = z.object({
  speakerId: z.string(),
  /** null = off-camera / unmatched voice. */
  trackId: IdSchema.nullable(),
  identityId: z.string().optional(),
  confidence: ConfidenceSchema,
  method: z.enum(["av-correlation", "single-face", "user", "heuristic", "none"]),
  evidence: z.string(),
});

export const FrameSheetSchema = z.object({
  id: IdSchema,
  path: z.string(),
  times: z.array(NonNegFlicksSchema),
  cols: z.int().positive(),
  rows: z.int().positive(),
  purpose: z.enum(["overview", "candidate", "dense", "cut-check", "qa", "caption-preview", "layout-preview"]),
  window: IntervalSchema.optional(),
});

export const AgentObservationSchema = z.object({
  sheetId: IdSchema.optional(),
  t: NonNegFlicksSchema.optional(),
  end: NonNegFlicksSchema.optional(),
  kind: z.enum(["reaction", "action", "on-screen-text", "screen-demo", "gesture", "laughter", "scene", "quality-issue", "gaze", "other"]),
  detail: z.string(),
  confidence: ConfidenceSchema,
  at: IsoDateSchema,
});

export const VisualAnalysisSchema = z.object({
  schemaVersion: z.literal(1),
  sourceId: IdSchema,
  detector: z.object({ name: z.string(), model: z.string(), version: z.string() }),
  sampling: z.object({
    baseFps: z.number().positive(),
    denseWindows: z.array(z.object({ start: FlicksSchema, end: FlicksSchema, fps: z.number().positive(), reason: z.string() })).default([]),
    framesAnalyzed: z.int().min(0),
    note: z.string(),
  }),
  frame: z.object({ width: z.int().positive(), height: z.int().positive() }),
  scenes: z.array(SceneSchema),
  faceTracks: z.array(FaceTrackSchema),
  speakerLinks: z.array(SpeakerLinkSchema).default([]),
  screenRegions: z
    .array(z.object({ start: FlicksSchema, end: FlicksSchema, box: BoxSchema, kind: z.enum(["screen", "slide", "text", "ui"]), confidence: ConfidenceSchema }))
    .default([]),
  frameSheets: z.array(FrameSheetSchema).default([]),
  observations: z.array(AgentObservationSchema).default([]),
  /** Black stretches in the source picture (never usable as camera footage). */
  blackIntervals: z.array(z.object({ start: NonNegFlicksSchema, end: NonNegFlicksSchema })).default([]),
  createdAt: IsoDateSchema,
});

export const AudioEventSchema = z.object({
  t: NonNegFlicksSchema,
  end: NonNegFlicksSchema.optional(),
  kind: z.enum(["laughter-candidate", "energy-peak", "emphasis", "long-pause", "clipping", "music-candidate", "noise", "overlap"]),
  confidence: ConfidenceSchema,
  detail: z.string(),
});

export const AudioFeaturesSchema = z.object({
  schemaVersion: z.literal(1),
  sourceId: IdSchema,
  sampleRate: z.int().positive(),
  windowMs: z.number().positive(),
  /** RMS dBFS envelope file (JSON array of numbers at windowMs spacing), full scale = 1.0. */
  envelopePath: z.string(),
  speech: z.array(z.object({ start: NonNegFlicksSchema, end: NonNegFlicksSchema })),
  pauses: z.array(z.object({ start: NonNegFlicksSchema, end: NonNegFlicksSchema })),
  loudness: z.object({ integratedLufs: z.number().nullable(), truePeakDbtp: z.number().nullable(), lraLu: z.number().nullable() }),
  noiseFloorDbfs: z.number().nullable(),
  events: z.array(AudioEventSchema).default([]),
  vadEngine: z.string(),
  createdAt: IsoDateSchema,
});

export const CoverageSchema = z.object({
  transcript: z.enum(["full", "partial", "none"]),
  visual: z.enum(["agent-inspected", "cv-only", "none"]),
  audio: z.enum(["full", "none"]),
  framesSampled: z.int().min(0),
  sheetsInspectedByAgent: z.array(IdSchema).default([]),
  limitations: z.array(z.string()).default([]),
});

export type Scene = z.infer<typeof SceneSchema>;
export type FaceSample = z.infer<typeof FaceSampleSchema>;
export type FaceTrack = z.infer<typeof FaceTrackSchema>;
export type SpeakerLink = z.infer<typeof SpeakerLinkSchema>;
export type FrameSheet = z.infer<typeof FrameSheetSchema>;
export type AgentObservation = z.infer<typeof AgentObservationSchema>;
export type VisualAnalysis = z.infer<typeof VisualAnalysisSchema>;
export type AudioEvent = z.infer<typeof AudioEventSchema>;
export type AudioFeatures = z.infer<typeof AudioFeaturesSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
