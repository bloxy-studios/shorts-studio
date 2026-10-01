import type { CaptionTrack } from "../schema/editplan.ts";
import { flicksToMs, formatSrtTime, formatVttTime } from "../time.ts";

function chunkLines(track: CaptionTrack, chunkIndex: number): string[] {
  const chunk = track.chunks[chunkIndex]!;
  const byId = new Map(chunk.words.map((w) => [w.id, w]));
  return chunk.lines.map((ids) =>
    ids
      .map((id) => byId.get(id)?.display ?? "")
      .filter(Boolean)
      .join(" "),
  );
}

/** Spoken subtitles only — authored titles/hooks are never exported as speech. */
export function toSrt(track: CaptionTrack): string {
  return track.chunks
    .map((c, i) => `${i + 1}\n${formatSrtTime(c.outStart)} --> ${formatSrtTime(c.outEnd)}\n${chunkLines(track, i).join("\n")}\n`)
    .join("\n");
}

export function toVtt(track: CaptionTrack): string {
  const cues = track.chunks.map((c, i) => `${c.id}\n${formatVttTime(c.outStart)} --> ${formatVttTime(c.outEnd)}\n${chunkLines(track, i).join("\n")}\n`);
  return `WEBVTT\nKind: captions\nLanguage: ${track.language}\n\n${cues.join("\n")}`;
}

export interface WordsJson {
  language: string;
  styleId: string;
  timebase: "ms";
  words: Array<{ id: string; sourceWordId: string; text: string; start: number; end: number; chunkId: string; emphasis: string; uncertain: boolean }>;
  chunks: Array<{ id: string; start: number; end: number; text: string; lines: string[] }>;
}

export function toWordsJson(track: CaptionTrack): WordsJson {
  const round = (f: number) => Math.round(flicksToMs(f) * 1000) / 1000;
  return {
    language: track.language,
    styleId: track.styleId,
    timebase: "ms",
    words: track.chunks.flatMap((c) =>
      c.words.map((w) => ({
        id: w.id,
        sourceWordId: w.sourceWordId,
        text: w.display,
        start: round(w.outStart),
        end: round(w.outEnd),
        chunkId: c.id,
        emphasis: w.emphasis,
        uncertain: w.uncertain,
      })),
    ),
    chunks: track.chunks.map((c, i) => ({
      id: c.id,
      start: round(c.outStart),
      end: round(c.outEnd),
      text: c.words.map((w) => w.display).join(" "),
      lines: chunkLines(track, i),
    })),
  };
}
