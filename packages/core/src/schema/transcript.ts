import { z } from "zod";
import { ConfidenceSchema, FlicksSchema, IdSchema, IsoDateSchema, NonNegFlicksSchema } from "./common.ts";

export const WordSchema = z.object({
  /** Stable source word id, e.g. "w000123". Final-timeline words reference it. */
  id: IdSchema,
  text: z.string(),
  start: NonNegFlicksSchema,
  end: NonNegFlicksSchema,
  confidence: ConfidenceSchema,
  segmentId: IdSchema,
  speaker: z.string().optional(),
  /** Timing confidence separate from recognition confidence. */
  timingConfidence: ConfidenceSchema.optional(),
  uncertain: z.boolean().default(false),
  flags: z.array(z.string()).default([]),
});

export const SegmentSchema = z.object({
  id: IdSchema,
  start: NonNegFlicksSchema,
  end: NonNegFlicksSchema,
  text: z.string(),
  wordIds: z.array(IdSchema),
  speaker: z.string().optional(),
  language: z.string().optional(),
  avgLogprob: z.number().optional(),
  noSpeechProb: z.number().optional(),
});

export const SpeakerTurnSchema = z.object({
  start: NonNegFlicksSchema,
  end: NonNegFlicksSchema,
  speaker: z.string(),
  confidence: ConfidenceSchema,
});

export const TranscriptSchema = z.object({
  schemaVersion: z.literal(1),
  sourceId: IdSchema,
  engine: z.object({
    name: z.string(),
    version: z.string(),
    model: z.string(),
    params: z.record(z.string(), z.unknown()).default({}),
    device: z.string().default("cpu"),
  }),
  language: z.string(),
  languageConfidence: ConfidenceSchema.optional(),
  /** Declared by the user vs detected by the engine. */
  languageSource: z.enum(["user", "detected", "default"]).default("detected"),
  durationFlicks: NonNegFlicksSchema,
  segments: z.array(SegmentSchema),
  words: z.array(WordSchema),
  speakers: z.array(z.object({ id: z.string(), label: z.string().optional(), speechFlicks: NonNegFlicksSchema.default(0) })).default([]),
  diarization: z
    .object({
      engine: z.string(),
      turns: z.array(SpeakerTurnSchema),
      overlaps: z.array(z.object({ start: FlicksSchema, end: FlicksSchema, speakers: z.array(z.string()) })).default([]),
    })
    .nullable()
    .default(null),
  createdAt: IsoDateSchema,
  notes: z.array(z.string()).default([]),
});

export type Word = z.infer<typeof WordSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type SpeakerTurn = z.infer<typeof SpeakerTurnSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
