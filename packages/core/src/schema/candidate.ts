import { z } from "zod";
import { ConfidenceSchema, EvidenceSchema, IdSchema, IsoDateSchema, NonNegFlicksSchema } from "./common.ts";

export const MomentKindSchema = z.enum([
  "funny-exchange",
  "surprising-claim",
  "useful-explanation",
  "emotional-story",
  "disagreement",
  "demonstration",
  "reaction",
  "quotable-insight",
  "setup-payoff",
  "other",
]);

/** Editorial potential criteria (not a virality probability). Weights live in presets. */
export const CriteriaSchema = z.object({
  hook: z.number().min(0).max(1),
  payoff: z.number().min(0).max(1),
  standalone: z.number().min(0).max(1),
  emotion: z.number().min(0).max(1),
  delivery: z.number().min(0).max(1),
  fit: z.number().min(0).max(1),
});

export const PenaltyKindSchema = z.enum([
  "missing-setup",
  "unresolved-reference",
  "weak-delivery",
  "misleading-truncation",
  "poor-audio",
  "duplicate",
  "unusable-crop",
]);

export const PenaltySchema = z.object({
  kind: PenaltyKindSchema,
  points: z.number().min(0),
  reason: z.string(),
});

export const BeatSchema = z.object({
  start: NonNegFlicksSchema,
  end: NonNegFlicksSchema,
  text: z.string(),
});

export const CandidateSchema = z.object({
  id: IdSchema,
  sourceId: IdSchema,
  kind: MomentKindSchema,
  start: NonNegFlicksSchema,
  end: NonNegFlicksSchema,
  tentativeDurationFlicks: NonNegFlicksSchema,
  title: z.string(),
  hook: z.string(),
  whyItHolds: z.string(),
  setup: BeatSchema.nullable(),
  beat: BeatSchema,
  payoff: BeatSchema.nullable(),
  evidence: z.array(EvidenceSchema),
  requiredContext: z.string().optional(),
  optionalTrims: z.array(z.object({ start: NonNegFlicksSchema, end: NonNegFlicksSchema, reason: z.string() })).default([]),
  reasonsNotToUse: z.array(z.string()).default([]),
  suggestions: z.object({
    framing: z.string(),
    captionStyleId: z.string(),
    intensity: z.enum(["restrained", "balanced", "energetic"]),
    coverTimeFlicks: NonNegFlicksSchema.optional(),
  }),
  scores: z.object({
    criteria: CriteriaSchema,
    weights: z.record(z.string(), z.number()),
    penalties: z.array(PenaltySchema).default([]),
    total: z.number(),
    reasons: z.array(z.string()).default([]),
  }),
  confidence: z.object({
    transcript: ConfidenceSchema,
    speakerMapping: ConfidenceSchema,
    visual: ConfidenceSchema,
    editorial: ConfidenceSchema,
  }),
  analysisLevel: z.enum(["audiovisual-agent", "audiovisual-cv", "transcript-only"]),
  preview: z.object({ path: z.string(), contactSheet: z.string().optional() }).nullable().default(null),
  selection: z.object({
    state: z.enum(["proposed", "selected", "rejected", "shortlisted"]),
    reason: z.string().optional(),
    at: IsoDateSchema.optional(),
  }),
  overlapGroup: z.string().optional(),
});

export const CandidateSetSchema = z.object({
  schemaVersion: z.literal(1),
  sourceId: IdSchema,
  createdAt: IsoDateSchema,
  requested: z.object({ count: z.int().positive(), minSec: z.number().positive(), maxSec: z.number().positive() }),
  weights: z.record(z.string(), z.number()),
  candidates: z.array(CandidateSchema),
  shortfall: z.string().nullable().default(null),
  method: z.string(),
});

export type MomentKind = z.infer<typeof MomentKindSchema>;
export type Criteria = z.infer<typeof CriteriaSchema>;
export type Penalty = z.infer<typeof PenaltySchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type CandidateSet = z.infer<typeof CandidateSetSchema>;
