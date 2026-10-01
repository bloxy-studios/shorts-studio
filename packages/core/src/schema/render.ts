import { z } from "zod";
import { IdSchema, IsoDateSchema } from "./common.ts";

export const StemMeasurementSchema = z.object({
  path: z.string(),
  durationSamples: z.int().min(0),
  sampleRate: z.int().positive(),
  channels: z.int().positive(),
  /** null when silent or the gated measurement is undefined. */
  integratedLufs: z.number().nullable(),
  samplePeakDbfs: z.number().nullable(),
  truePeakDbtp: z.number().nullable(),
  note: z.string().optional(),
});

export const RenderRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  clipId: IdSchema,
  planVersion: z.int().positive(),
  kind: z.enum(["draft", "final", "sample", "preview"]),
  status: z.enum(["rendering", "done", "failed", "blocked"]),
  createdAt: IsoDateSchema,
  finishedAt: IsoDateSchema.optional(),
  profile: z.object({
    width: z.int(),
    height: z.int(),
    fps: z.string(),
    videoCodec: z.string(),
    pixFmt: z.string(),
    crf: z.int(),
    audioCodec: z.string(),
    sampleRate: z.int(),
    audioChannels: z.int(),
  }),
  paths: z.record(z.string(), z.string()),
  stems: z.record(z.string(), StemMeasurementSchema).default({}),
  master: StemMeasurementSchema.nullable().default(null),
  probe: z.record(z.string(), z.unknown()).default({}),
  timings: z.record(z.string(), z.number()).default({}),
  qaVerdict: z.enum(["pass", "pass-with-warnings", "draft", "blocked", "not-run"]).default("not-run"),
  approved: z.boolean().default(false),
  notes: z.array(z.string()).default([]),
});

export type StemMeasurement = z.infer<typeof StemMeasurementSchema>;
export type RenderRecord = z.infer<typeof RenderRecordSchema>;
