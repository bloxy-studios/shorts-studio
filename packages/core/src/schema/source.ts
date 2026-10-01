import { z } from "zod";
import { FlicksSchema, IdSchema, IsoDateSchema, NonNegFlicksSchema, RationalSchema } from "./common.ts";

export const VideoStreamSchema = z.object({
  index: z.int().min(0),
  codec: z.string(),
  profile: z.string().optional(),
  width: z.int().positive(),
  height: z.int().positive(),
  /** Upright dimensions after applying rotation metadata. */
  displayWidth: z.int().positive(),
  displayHeight: z.int().positive(),
  rotation: z.int(),
  sampleAspectRatio: z.string().optional(),
  fps: RationalSchema,
  avgFps: RationalSchema.nullable(),
  isVFR: z.boolean(),
  vfrEvidence: z.string().optional(),
  pixFmt: z.string(),
  bitDepth: z.int().positive(),
  colorTransfer: z.string().optional(),
  colorPrimaries: z.string().optional(),
  colorSpace: z.string().optional(),
  colorRange: z.string().optional(),
  isHDR: z.boolean(),
  hdrKind: z.enum(["pq", "hlg"]).nullable(),
  startTimeFlicks: FlicksSchema,
  durationFlicks: NonNegFlicksSchema.optional(),
  frameCountEstimate: z.int().min(0).optional(),
});

export const AudioStreamSchema = z.object({
  index: z.int().min(0),
  codec: z.string(),
  channels: z.int().positive(),
  channelLayout: z.string().optional(),
  sampleRate: z.int().positive(),
  startTimeFlicks: FlicksSchema,
  durationFlicks: NonNegFlicksSchema.optional(),
  language: z.string().optional(),
  title: z.string().optional(),
});

export const SourceProbeSchema = z.object({
  formatName: z.string(),
  durationFlicks: NonNegFlicksSchema,
  startTimeFlicks: FlicksSchema,
  sizeBytes: z.int().min(0),
  bitRate: z.int().min(0).optional(),
  video: VideoStreamSchema.nullable(),
  audio: z.array(AudioStreamSchema),
  subtitleStreams: z.array(z.object({ index: z.int(), codec: z.string(), language: z.string().optional() })).default([]),
  tags: z.record(z.string(), z.string()).default({}),
});

export const AcquisitionAttemptSchema = z.object({
  at: IsoDateSchema,
  tool: z.string(),
  toolVersion: z.string().optional(),
  ok: z.boolean(),
  diagnosis: z
    .enum(["ok", "missing-dependency", "extractor-outdated", "unavailable", "sign-in-required", "geo-restricted", "network", "private", "live-or-upcoming", "unknown"])
    .optional(),
  message: z.string().optional(),
});

export const SourceAssetSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  kind: z.enum(["youtube", "url", "file", "folder-item", "manifest-item"]),
  role: z.enum(["primary", "camera", "mic", "screen", "broll", "reference"]).default("primary"),
  /** What the user supplied, with any credentials redacted. */
  input: z.string(),
  normalizedUrl: z.string().optional(),
  youtubeId: z.string().optional(),
  playlistId: z.string().optional(),
  /** A t= / start= hint from the URL. Analysis still covers the full video unless asked. */
  startHintFlicks: NonNegFlicksSchema.optional(),
  localPath: z.string(),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  sizeBytes: z.int().min(0),
  acquisition: z.object({
    status: z.enum(["pending", "acquired", "failed", "local"]),
    tool: z.string().optional(),
    toolVersion: z.string().optional(),
    formatId: z.string().optional(),
    attempts: z.array(AcquisitionAttemptSchema).default([]),
    completedAt: IsoDateSchema.optional(),
  }),
  provenance: z.object({
    title: z.string().optional(),
    uploader: z.string().optional(),
    channel: z.string().optional(),
    channelUrl: z.string().optional(),
    webpageUrl: z.string().optional(),
    uploadDate: z.string().optional(),
    license: z.string().optional(),
    description: z.string().optional(),
    attribution: z.string(),
  }),
  subtitles: z.array(z.object({ language: z.string(), kind: z.enum(["manual", "auto"]), path: z.string() })).default([]),
  probe: SourceProbeSchema,
  derived: z
    .object({
      analysisProxy: z.object({ path: z.string(), width: z.int(), height: z.int(), fps: RationalSchema }).optional(),
      audio16k: z.object({ path: z.string(), sampleRate: z.literal(16000), channels: z.literal(1), streamIndex: z.int() }).optional(),
      audio48k: z.object({ path: z.string(), sampleRate: z.literal(48000), channels: z.int(), streamIndex: z.int() }).optional(),
      colorPath: z.string().optional(),
    })
    .default({}),
  createdAt: IsoDateSchema,
});

export type VideoStream = z.infer<typeof VideoStreamSchema>;
export type AudioStream = z.infer<typeof AudioStreamSchema>;
export type SourceProbe = z.infer<typeof SourceProbeSchema>;
export type SourceAsset = z.infer<typeof SourceAssetSchema>;
export type AcquisitionAttempt = z.infer<typeof AcquisitionAttemptSchema>;
