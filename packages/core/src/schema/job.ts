import { z } from "zod";
import { IdSchema, IsoDateSchema } from "./common.ts";

export const StageStatusSchema = z.enum(["pending", "running", "done", "failed", "cancelled", "skipped"]);

/** Persisted per-stage state; `key` hashes the stage inputs so reruns can reuse outputs. */
export const StageStateSchema = z.object({
  stage: z.string(),
  key: z.string(),
  status: StageStatusSchema,
  startedAt: IsoDateSchema.optional(),
  finishedAt: IsoDateSchema.optional(),
  inputs: z.record(z.string(), z.string()).default({}),
  outputs: z.array(z.string()).default([]),
  attempts: z.int().min(0).default(0),
  error: z.string().optional(),
  note: z.string().optional(),
});

export const JobManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  projectId: IdSchema,
  kind: z.string(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  status: StageStatusSchema,
  cancelRequested: z.boolean().default(false),
  stages: z.array(StageStateSchema),
  progress: z.object({ stage: z.string(), fraction: z.number().min(0).max(1), message: z.string() }).optional(),
});

export type StageStatus = z.infer<typeof StageStatusSchema>;
export type StageState = z.infer<typeof StageStateSchema>;
export type JobManifest = z.infer<typeof JobManifestSchema>;
