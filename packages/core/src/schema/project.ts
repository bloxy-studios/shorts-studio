import { z } from "zod";
import { IdSchema, IsoDateSchema } from "./common.ts";

export const ModeSchema = z.enum(["guided", "director", "autonomous"]);
export const PlatformSchema = z.enum(["youtube-shorts", "tiktok", "instagram-reels", "generic-9x16"]);
export const IntensitySchema = z.enum(["restrained", "balanced", "energetic"]);

/** Every answered question or autonomous choice, so it is never asked twice. */
export const DecisionSchema = z.object({
  key: z.string(),
  question: z.string().optional(),
  answer: z.unknown(),
  source: z.enum(["user", "default", "inferred", "autonomous", "preference"]),
  scope: z.enum(["project", "clip", "session"]).default("project"),
  clipId: IdSchema.optional(),
  persisted: z.boolean().default(false),
  at: IsoDateSchema,
  note: z.string().optional(),
});

export const ClipEntrySchema = z.object({
  id: IdSchema,
  title: z.string().optional(),
  candidateId: IdSchema.optional(),
  kind: z.enum(["clip", "creator-edit", "edit"]).default("clip"),
  currentPlanVersion: z.int().min(0).default(0),
  approvedRenderId: IdSchema.nullable().default(null),
  latestRenderId: IdSchema.nullable().default(null),
});

export const ProjectConfigSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  name: z.string(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  mode: ModeSchema.default("guided"),
  presetId: z.string().default("social-dynamic"),
  captionStyleId: z.string().optional(),
  intensity: IntensitySchema.optional(),
  platforms: z.array(PlatformSchema).default(["generic-9x16"]),
  clipCount: z.int().positive().optional(),
  durationBand: z.object({ minSec: z.number().positive(), maxSec: z.number().positive() }).optional(),
  language: z.string().optional(),
  providers: z
    .object({
      transcription: z.string().default("whisper-cpp"),
      vision: z.enum(["agent-frames", "cv-only", "none"]).default("agent-frames"),
      allowUploads: z.boolean().default(false),
    })
    .default({ transcription: "whisper-cpp", vision: "agent-frames", allowUploads: false }),
  repair: z
    .object({ maxPasses: z.int().min(0).default(3), maxMinutes: z.number().positive().default(45) })
    .default({ maxPasses: 3, maxMinutes: 45 }),
  decisions: z.array(DecisionSchema).default([]),
  sources: z.array(IdSchema).default([]),
  clips: z.array(ClipEntrySchema).default([]),
});

export type Mode = z.infer<typeof ModeSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type ClipEntry = z.infer<typeof ClipEntrySchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
