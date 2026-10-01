import { z } from "zod";

/** Integer flicks (see time.ts). */
export const FlicksSchema = z.int();
export const NonNegFlicksSchema = z.int().min(0);

export const RationalSchema = z.object({
  num: z.int().positive(),
  den: z.int().positive(),
});

export const IntervalSchema = z
  .object({ start: FlicksSchema, end: FlicksSchema })
  .refine((i) => i.end > i.start, { message: "interval end must be after start" });

export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "ids use letters, digits, . _ : -");

export const IsoDateSchema = z.string().min(10);

export const ConfidenceSchema = z.number().min(0).max(1);

/** Pixel box in a named coordinate space (source frame pixels unless stated). */
export const BoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});

export const EvidenceSchema = z.object({
  kind: z.enum(["transcript", "audio", "visual-cv", "visual-agent", "provider", "user", "metadata"]),
  t: FlicksSchema.optional(),
  end: FlicksSchema.optional(),
  detail: z.string(),
  ref: z.string().optional(),
});

export type Box = z.infer<typeof BoxSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type RationalT = z.infer<typeof RationalSchema>;
