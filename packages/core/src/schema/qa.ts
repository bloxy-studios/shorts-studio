import { z } from "zod";
import { FlicksSchema, IdSchema, IsoDateSchema } from "./common.ts";

export const QACategorySchema = z.enum(["timing", "captions", "framing", "audio", "export", "graphics", "editorial", "layout"]);

export const QAFindingSchema = z.object({
  id: IdSchema,
  check: z.string(),
  category: QACategorySchema,
  /** hard = blocks a final delivery; soft = should fix; info = recorded observation. */
  severity: z.enum(["hard", "soft", "info"]),
  status: z.enum(["pass", "fail", "warn", "not-run"]),
  message: z.string(),
  evidence: z
    .object({
      frames: z.array(z.string()).default([]),
      times: z.array(FlicksSchema).default([]),
      measurements: z.record(z.string(), z.unknown()).default({}),
    })
    .default({ frames: [], times: [], measurements: {} }),
  affects: z
    .object({
      segmentIds: z.array(IdSchema).default([]),
      runIds: z.array(IdSchema).default([]),
      chunkIds: z.array(IdSchema).default([]),
      eventIds: z.array(IdSchema).default([]),
      stage: z.string().optional(),
    })
    .default({ segmentIds: [], runIds: [], chunkIds: [], eventIds: [] }),
  repair: z.object({ rule: z.string(), action: z.string() }).optional(),
});

export const InspectionRecordSchema = z.object({
  what: z.string(),
  how: z.enum(["automated", "agent-visual", "agent-audio-measure", "human", "not-performed"]),
  artifact: z.string().optional(),
  notes: z.string(),
});

export const QAReportSchema = z.object({
  schemaVersion: z.literal(1),
  clipId: IdSchema,
  renderId: IdSchema,
  planVersion: z.int().positive(),
  createdAt: IsoDateSchema,
  findings: z.array(QAFindingSchema),
  inspection: z.array(InspectionRecordSchema).default([]),
  summary: z.object({
    hardFailures: z.int().min(0),
    softFailures: z.int().min(0),
    warnings: z.int().min(0),
    passed: z.int().min(0),
    notRun: z.int().min(0),
    verdict: z.enum(["pass", "pass-with-warnings", "draft", "blocked"]),
  }),
});

export type QACategory = z.infer<typeof QACategorySchema>;
export type QAFinding = z.infer<typeof QAFindingSchema>;
export type InspectionRecord = z.infer<typeof InspectionRecordSchema>;
export type QAReport = z.infer<typeof QAReportSchema>;
