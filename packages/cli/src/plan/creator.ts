import {
  flicksPerFrame,
  flicksToSeconds,
  msToFlicks,
  quantizeToFrame,
  quantizeToSample,
  secondsToFlicks,
  type Flicks,
  type PlanSource,
  type SourceAsset,
  type SourceClock,
  type TimelineSegment,
  type Transcript,
} from "../../../core/src/index.ts";
import type { TakeAnalysis } from "../../../core/src/takes/detect.ts";

export interface LineEndpoint {
  id: string;
  startS: number;
  endS: number;
  quiet: Array<{ startS: number; endS: number; ms: number }>;
  deviation: string | null;
}

export interface CreatorAssemblyInput {
  camera: SourceAsset;
  mic: SourceAsset;
  clock: SourceClock;
  takes: TakeAnalysis;
  endpoints: LineEndpoint[];
  fps: { num: number; den: number };
  rules: {
    preRollMs: number;
    compressAboveMs: number;
    compressToMs: number;
    jCutLeadMs: number;
    tailFadeMaxMs: number;
    joinGapMs: number;
  };
}

export interface CreatorAssembly {
  segments: TimelineSegment[];
  sources: PlanSource[];
  notes: string[];
  /** Exact end of the last meaningful voice sample (output time). */
  voiceEnd: Flicks;
  deviations: string[];
}

/** Mic time → camera time (inverse of the fitted clock). */
function micToCamera(clock: SourceClock, micTime: Flicks): Flicks {
  const drift = clock.driftPpm * 1e-6;
  return Math.round((micTime - clock.offsetFlicks + drift * clock.anchorFlicks) / (1 + drift));
}

/**
 * Assembles chosen takes into a timeline: picture from the camera (hard cuts on the
 * frame grid), voice from the clean mic placed through the fitted clock so lips stay
 * in sync, interior J-cuts of `jCutLeadMs`, compressed internal pauses, faded tails
 * that never run into the next sound, and joins without long quiet stretches.
 */
export function assembleCreator(input: CreatorAssemblyInput): CreatorAssembly {
  const { camera, mic, clock, rules } = input;
  const fps = input.fps;
  const frame = flicksPerFrame(fps);
  const sr = 48_000;
  const notes: string[] = [];
  const deviations: string[] = [];
  const pre = msToFlicks(rules.preRollMs);
  const lead = quantizeToSample(msToFlicks(rules.jCutLeadMs), sr);
  const joinGap = msToFlicks(rules.joinGapMs);

  // Spans of mic time to keep: each chosen line, split at long internal pauses.
  type Span = { lineId: string; micStart: Flicks; micEnd: Flicks; first: boolean; lastOfLine: boolean };
  const spans: Span[] = [];
  for (const line of input.takes.lines) {
    const ep = input.endpoints.find((e) => e.id === line.id);
    if (!ep) continue;
    if (ep.deviation) deviations.push(`${line.id}: ${ep.deviation}`);
    const start = secondsToFlicks(ep.startS) - pre;
    let end = secondsToFlicks(ep.endS);
    // Only pauses between words are compressed. A long quiet after the last word ends the
    // line there (natural decay kept) instead of leaving a wordless tail piece after a cut.
    const words = line.chosen.sentence.words;
    const lastWordEnd = words[words.length - 1]!.end;
    const tailQuiet = ep.quiet.find((q) => q.ms > rules.compressAboveMs && secondsToFlicks(q.startS) >= lastWordEnd - msToFlicks(30) && q.startS < ep.endS);
    if (tailQuiet) {
      const cutAt = secondsToFlicks(tailQuiet.startS) + msToFlicks(rules.compressToMs / 2);
      if (cutAt < end) {
        notes.push(`${line.id}: ended at the ${Math.round(tailQuiet.ms)} ms quiet after its last word (dropped ${Math.round((end - cutAt) / 705_600)} ms of trailing non-speech)`);
        end = cutAt;
      }
    }
    const cuts = ep.quiet.filter((q) => q.ms > rules.compressAboveMs && q.startS > ep.startS && secondsToFlicks(q.endS) <= lastWordEnd && secondsToFlicks(q.endS) < end);
    let s = Math.max(0, start);
    const keepHalf = msToFlicks(rules.compressToMs / 2);
    cuts.forEach((q) => {
      spans.push({ lineId: line.id, micStart: s, micEnd: secondsToFlicks(q.startS) + keepHalf, first: s === Math.max(0, start), lastOfLine: false });
      s = secondsToFlicks(q.endS) - keepHalf;
    });
    spans.push({ lineId: line.id, micStart: s, micEnd: end, first: cuts.length === 0 ? true : false, lastOfLine: true });
    if (cuts.length) notes.push(`${line.id}: compressed ${cuts.length} pause(s) over ${rules.compressAboveMs} ms toward ${rules.compressToMs} ms`);
  }

  const segments: TimelineSegment[] = [];
  let picCursor = 0; // output time where the next picture starts
  let prevVoiceEnd = 0; // output time of the previous span's last voice sample
  spans.forEach((sp, i) => {
    const isFirst = i === 0;
    const len = sp.micEnd - sp.micStart;
    // Voice start in output: right after the previous voice with a short natural gap.
    let audioOut = isFirst ? 0 : prevVoiceEnd + joinGap;
    let picOut: Flicks;
    let jcut = 0;
    if (isFirst) {
      picOut = 0;
    } else {
      // Interior join: picture cut on the frame grid, voice leads it by `lead` (audio-only J-cut).
      picOut = quantizeToFrame(audioOut + (sp.first ? lead : 0), fps, "round");
      jcut = sp.first ? lead : 0;
      audioOut = Math.max(0, picOut - jcut);
    }
    audioOut = quantizeToSample(audioOut, sr);
    // Close the previous segment's picture exactly at this cut (tiling).
    const prev = segments[segments.length - 1];
    if (prev) prev.picture.outEnd = picOut;
    const camStart = micToCamera(clock, sp.micStart + jcut);
    const micStart = sp.micStart;
    const audioLen = quantizeToSample(len, sr);
    const tailRoom = i + 1 < spans.length ? joinGap + msToFlicks(rules.preRollMs) : msToFlicks(rules.tailFadeMaxMs);
    const fadeOut = quantizeToSample(Math.min(msToFlicks(rules.tailFadeMaxMs), tailRoom, Math.floor(audioLen / 3)), sr);
    segments.push({
      id: `seg${String(i + 1).padStart(3, "0")}`,
      // srcStart is finalised below from the mic clock so lips stay in sync.
      picture: { sourceId: camera.id, srcStart: Math.max(0, camStart), outStart: picOut, outEnd: picOut + frame, rate: { num: 1, den: 1 } },
      audio: [
        {
          id: "voice",
          sourceId: mic.id,
          srcStart: micStart,
          outStart: audioOut,
          outEnd: audioOut + audioLen,
          fadeInFlicks: isFirst ? quantizeToSample(msToFlicks(5), sr) : quantizeToSample(Math.min(lead, msToFlicks(30)), sr),
          fadeOutFlicks: sp.lastOfLine ? fadeOut : quantizeToSample(msToFlicks(8), sr),
          gainDb: 0,
          role: "voice",
        },
      ],
      lineId: sp.lineId,
      takeId: input.takes.lines.find((l) => l.id === sp.lineId)?.chosen.id,
      wordIds: [],
      note: jcut ? `audio leads picture by ${Math.round(flicksToSeconds(jcut) * 1000)} ms (J-cut)` : undefined,
    } as TimelineSegment);
    prevVoiceEnd = audioOut + audioLen;
  });
  // Picture srcStart must keep lip sync: camera time of the mic sample presented at picture start.
  for (const seg of segments) {
    const a = seg.audio[0]!;
    const micAtPicture = a.srcStart + (seg.picture.outStart - a.outStart);
    seg.picture.srcStart = Math.max(0, micToCamera(clock, micAtPicture));
  }
  const last = segments[segments.length - 1];
  const voiceEnd = last ? last.audio[0]!.outEnd : 0;
  if (last) last.picture.outEnd = quantizeToFrame(voiceEnd, fps, "ceil");
  for (const seg of segments) if (seg.picture.outEnd <= seg.picture.outStart) seg.picture.outEnd = seg.picture.outStart + frame;
  const sources: PlanSource[] = [
    { sourceId: camera.id, role: "camera", clock: null },
    { sourceId: mic.id, role: "mic", clock },
  ];
  return { segments, sources, notes, voiceEnd, deviations };
}

export function wordsForSegments(transcript: Transcript, segments: TimelineSegment[]): TimelineSegment[] {
  return segments.map((s) => {
    const a = s.audio[0]!;
    const end = a.srcStart + (a.outEnd - a.outStart);
    return { ...s, wordIds: transcript.words.filter((w) => w.start >= a.srcStart && w.end <= end).map((w) => w.id) };
  });
}
