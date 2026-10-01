import {
  buildTimeMapPieces,
  computeExtent,
  flicksPerFrame,
  msToFlicks,
  quantizeToSample,
  rational,
  secondsToFlicks,
  type EditPlan,
  type TimelineSegment,
  type Word,
} from "../../packages/core/src/index.ts";

export const S = secondsToFlicks;
export const MS = msToFlicks;
export const FPS60 = rational(60);

export function word(id: string, text: string, startSec: number, endSec: number, extra: Partial<Word> = {}): Word {
  return { id, text, start: S(startSec), end: S(endSec), confidence: 0.95, segmentId: "seg1", uncertain: false, flags: [], ...extra };
}

/** Sentence of evenly spaced words starting at `t0` (seconds). */
export function sentence(prefix: string, text: string, t0: number, wordSec = 0.3, gapSec = 0.05): Word[] {
  return text.split(" ").map((t, i) => {
    const s = t0 + i * (wordSec + gapSec);
    return word(`${prefix}${String(i).padStart(3, "0")}`, t, s, s + wordSec);
  });
}

/**
 * Builds a structurally valid plan from picture/audio source ranges.
 * Each entry: [srcStartSec, durSec] on source "cam"; hard cuts between them,
 * optional audio J-cut lead in ms for all but the first segment.
 */
export function makePlan(ranges: Array<[number, number]>, opts: { jcutLeadMs?: number; fps?: ReturnType<typeof rational> } = {}): EditPlan {
  const fps = opts.fps ?? FPS60;
  const frame = flicksPerFrame(fps);
  const segments: TimelineSegment[] = [];
  let out = 0;
  ranges.forEach(([srcSec, durSec], i) => {
    const dur = Math.round(S(durSec) / frame) * frame;
    const srcStart = S(srcSec);
    const lead = i > 0 ? quantizeToSample(MS(opts.jcutLeadMs ?? 0), 48_000) : 0;
    segments.push({
      id: `seg${i + 1}`,
      picture: { sourceId: "cam", srcStart, outStart: out, outEnd: out + dur, rate: { num: 1, den: 1 } },
      audio: [
        {
          id: "a1",
          sourceId: "cam",
          srcStart: srcStart - lead,
          outStart: out - lead,
          outEnd: out + dur,
          fadeInFlicks: 0,
          fadeOutFlicks: 0,
          gainDb: 0,
          role: "voice",
        },
      ],
      wordIds: [],
    });
    out += dur;
  });
  const extent = computeExtent(segments, fps);
  return {
    schemaVersion: 1,
    projectId: "p1",
    clipId: "clip-01",
    version: 1,
    parentVersion: null,
    createdAt: "2026-09-30T00:00:00.000Z",
    createdBy: "planner",
    changeSummary: "test",
    changes: [],
    presetId: "social-dynamic",
    presetVersion: "1.0.0",
    briefVersion: null,
    output: {
      width: 1080,
      height: 1920,
      fps,
      sampleRate: 48_000,
      audioChannels: 2,
      durationFlicks: extent.end,
      voiceEndFlicks: extent.voiceEnd,
      frameCount: extent.frameCount,
      video: { codec: "h264", pixFmt: "yuv420p", crf: 18, preset: "medium", profile: "high" },
      audio: { codec: "aac", bitrateKbps: 192 },
    },
    sources: [{ sourceId: "cam", role: "primary", clock: null }],
    segments,
    timeMap: buildTimeMapPieces(segments),
    layoutRuns: [
      {
        id: "run1",
        outStart: 0,
        outEnd: extent.end,
        layout: "full-crop",
        slots: [{ slot: "main", cropPathId: "crop1", region: { x: 0, y: 0, w: 1080, h: 1920 }, radius: 0, blurPx: 0, dim: 0 }],
        captionZone: { y0: 1267, y1: 1536 },
        reason: "test",
        eventIds: [],
        exceptions: [],
      },
    ],
    cropPaths: [
      {
        id: "crop1",
        sourceId: "cam",
        slot: "main",
        aspect: 1080 / 1920,
        keyframes: [{ t: 0, box: { x: 656.25, y: 0, w: 607.5, h: 1080 }, hold: true }],
        interpolation: "hold",
        trackIds: [],
        reason: "test",
        confidence: 1,
        manual: false,
      },
    ],
    captions: null,
    titleOverlays: [],
    graphics: [],
    audio: {
      sourceAudioPolicy: "keep-source-mix",
      voice: { sourceId: "cam", chain: { highpassHz: 80, denoise: "off", deess: false, compress: false, targetLufs: -14 } },
      music: { mode: "none", seed: 1, bpm: 110, key: "C", targetLufs: null, fadeOutFlicks: 0, declickFlicks: 0, ducking: false, gainDb: 0, params: {} },
      sfx: [],
      riser: null,
      master: { targetLufs: -14, maxTruePeakDbtp: -1, limiter: "if-needed" },
    },
    cover: null,
    cta: null,
    takes: [],
    decisions: [],
    fallbacks: [],
    locks: [],
  };
}
