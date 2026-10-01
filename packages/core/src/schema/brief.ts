import { z } from "zod";
import { IdSchema, IsoDateSchema } from "./common.ts";

/** A single enforceable rule with units/tolerance, traced to where it came from. */
export const RuleSchema = z.object({
  id: z.string(),
  area: z.enum(["editorial", "timing", "layout", "framing", "captions", "graphics", "audio", "export", "qa"]),
  rule: z.string(),
  param: z.unknown().optional(),
  unit: z.string().optional(),
  tolerance: z.unknown().optional(),
  hard: z.boolean(),
  source: z.enum(["user", "preset", "project", "brief", "default", "qa-refinement"]),
  sourceRef: z.string().optional(),
});

export const BriefChangeSchema = z.object({
  fromVersion: z.string().nullable(),
  toVersion: z.string(),
  at: IsoDateSchema,
  ruleIds: z.array(z.string()),
  change: z.string(),
  trigger: z.enum(["user-feedback", "qa-finding", "initial", "preference"]),
  evidence: z.string(),
});

export const BriefConstraintsSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().regex(/^brief-v\d{3}$/),
  projectId: IdSchema,
  clipId: IdSchema.optional(),
  createdAt: IsoDateSchema,
  presetId: z.string(),
  intent: z.object({
    goal: z.string(),
    audience: z.string(),
    hook: z.string(),
    payoff: z.string(),
    platforms: z.array(z.string()),
  }),
  evidence: z.array(z.object({ claim: z.string(), confidence: z.number().min(0).max(1), ref: z.string().optional() })).default([]),
  rules: z.array(RuleSchema),
  conflicts: z
    .array(z.object({ ruleIds: z.array(z.string()), resolution: z.string(), askedUser: z.boolean() }))
    .default([]),
  qaChecks: z.array(z.string()),
  fallbacks: z.array(z.object({ capability: z.string(), fallback: z.string(), reason: z.string() })).default([]),
  stopCriteria: z.object({ maxRepairPasses: z.int().min(0), maxMinutes: z.number().positive(), requireNoHardFailures: z.boolean() }),
  changelog: z.array(BriefChangeSchema).default([]),
});

export type Rule = z.infer<typeof RuleSchema>;
export type BriefChange = z.infer<typeof BriefChangeSchema>;
export type BriefConstraints = z.infer<typeof BriefConstraintsSchema>;
