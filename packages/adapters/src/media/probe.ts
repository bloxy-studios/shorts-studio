import { statSync } from "node:fs";
import {
  parseRational,
  rationalToNumber,
  secondsToFlicks,
  SourceProbeSchema,
  type AudioStream,
  type SourceProbe,
  type VideoStream,
} from "../../../core/src/index.ts";
import { run } from "../proc.ts";
import { tool } from "../tools.ts";

interface FfStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_space?: string;
  color_range?: string;
  start_time?: string;
  duration?: string;
  nb_frames?: string;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
  disposition?: Record<string, number>;
}

interface FfFormat {
  format_name: string;
  duration?: string;
  start_time?: string;
  size?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === "N/A") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function bitDepthOf(s: FfStream): number {
  const raw = num(s.bits_per_raw_sample);
  if (raw) return raw;
  const m = /(\d+)(le|be)$/.exec(s.pix_fmt ?? "");
  return m ? Number(m[1]) : 8;
}

function rotationOf(s: FfStream): number {
  const side = s.side_data_list?.find((d) => typeof d.rotation === "number");
  const r = side?.rotation ?? num(s.tags?.rotate) ?? 0;
  return ((Math.round(r) % 360) + 360) % 360;
}

/** Measures packet timing on the first ~20 s to confirm variable frame rate. */
async function detectVfr(path: string, streamIndex: number): Promise<{ isVFR: boolean; evidence: string }> {
  const res = await run(
    [tool("ffprobe"), "-v", "error", "-select_streams", `${streamIndex}`, "-read_intervals", "%+20", "-show_entries", "packet=pts_time", "-of", "csv=p=0", path],
    { allowFailure: true, timeoutMs: 60_000 },
  );
  const pts = res.stdout
    .split("\n")
    .map((l) => Number(l.split(",")[0]))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (pts.length < 10) return { isVFR: false, evidence: `only ${pts.length} packets sampled` };
  const deltas: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i]! - pts[i - 1]!;
    if (d > 0) deltas.push(d);
  }
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const sd = Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length);
  const cv = sd / mean;
  const isVFR = cv > 0.05;
  return { isVFR, evidence: `${deltas.length} packet intervals, mean ${(mean * 1000).toFixed(2)} ms, cv ${cv.toFixed(3)}` };
}

export async function probeMedia(path: string): Promise<SourceProbe> {
  const res = await run([tool("ffprobe"), "-v", "error", "-show_format", "-show_streams", "-of", "json", path], { timeoutMs: 120_000 });
  const json = JSON.parse(res.stdout) as { streams: FfStream[]; format: FfFormat };
  const fmt = json.format;
  const formatStart = secondsToFlicks(num(fmt.start_time) ?? 0);
  const videoStreams = json.streams.filter((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const vs = videoStreams[0];
  let video: VideoStream | null = null;
  if (vs && vs.width && vs.height) {
    const rotation = rotationOf(vs);
    const swap = rotation === 90 || rotation === 270;
    const fps = parseRational(vs.r_frame_rate && vs.r_frame_rate !== "0/0" ? vs.r_frame_rate : "30/1");
    const avg = vs.avg_frame_rate && vs.avg_frame_rate !== "0/0" ? parseRational(vs.avg_frame_rate) : null;
    const mismatch = avg ? Math.abs(rationalToNumber(avg) - rationalToNumber(fps)) / rationalToNumber(fps) > 0.005 : false;
    const vfr = mismatch ? await detectVfr(path, vs.index) : { isVFR: false, evidence: "r_frame_rate matches avg_frame_rate" };
    const transfer = vs.color_transfer;
    const hdrKind = transfer === "smpte2084" ? "pq" : transfer === "arib-std-b67" ? "hlg" : null;
    video = {
      index: vs.index,
      codec: vs.codec_name ?? "unknown",
      ...(vs.profile ? { profile: vs.profile } : {}),
      width: vs.width,
      height: vs.height,
      displayWidth: swap ? vs.height : vs.width,
      displayHeight: swap ? vs.width : vs.height,
      rotation,
      ...(vs.sample_aspect_ratio ? { sampleAspectRatio: vs.sample_aspect_ratio } : {}),
      fps,
      avgFps: avg,
      isVFR: vfr.isVFR,
      vfrEvidence: vfr.evidence,
      pixFmt: vs.pix_fmt ?? "unknown",
      bitDepth: bitDepthOf(vs),
      ...(transfer ? { colorTransfer: transfer } : {}),
      ...(vs.color_primaries ? { colorPrimaries: vs.color_primaries } : {}),
      ...(vs.color_space ? { colorSpace: vs.color_space } : {}),
      ...(vs.color_range ? { colorRange: vs.color_range } : {}),
      isHDR: hdrKind !== null,
      hdrKind,
      startTimeFlicks: secondsToFlicks(num(vs.start_time) ?? 0) - formatStart,
      ...(num(vs.duration) !== undefined ? { durationFlicks: secondsToFlicks(num(vs.duration)!) } : {}),
      ...(num(vs.nb_frames) !== undefined ? { frameCountEstimate: num(vs.nb_frames)! } : {}),
    };
  }
  const audio: AudioStream[] = json.streams
    .filter((s) => s.codec_type === "audio")
    .map((s) => ({
      index: s.index,
      codec: s.codec_name ?? "unknown",
      channels: s.channels ?? 1,
      ...(s.channel_layout ? { channelLayout: s.channel_layout } : {}),
      sampleRate: num(s.sample_rate) ?? 48000,
      startTimeFlicks: secondsToFlicks(num(s.start_time) ?? 0) - formatStart,
      ...(num(s.duration) !== undefined ? { durationFlicks: secondsToFlicks(num(s.duration)!) } : {}),
      ...(s.tags?.language ? { language: s.tags.language } : {}),
      ...(s.tags?.title ? { title: s.tags.title } : {}),
    }));
  const subtitleStreams = json.streams
    .filter((s) => s.codec_type === "subtitle")
    .map((s) => ({ index: s.index, codec: s.codec_name ?? "unknown", ...(s.tags?.language ? { language: s.tags.language } : {}) }));

  const durationSec = num(fmt.duration) ?? (vs ? num(vs.duration) : undefined) ?? 0;
  const probe: SourceProbe = {
    formatName: fmt.format_name,
    durationFlicks: secondsToFlicks(durationSec),
    startTimeFlicks: formatStart,
    sizeBytes: num(fmt.size) ?? statSync(path).size,
    ...(num(fmt.bit_rate) !== undefined ? { bitRate: num(fmt.bit_rate)! } : {}),
    video,
    audio,
    subtitleStreams,
    tags: fmt.tags ?? {},
  };
  return SourceProbeSchema.parse(probe);
}

/** Chooses the audio stream to use as speech: default disposition, else most channels, else first. */
export function pickSpeechStream(probe: SourceProbe): AudioStream | null {
  if (probe.audio.length === 0) return null;
  return [...probe.audio].sort((a, b) => b.channels - a.channels)[0] ?? null;
}
