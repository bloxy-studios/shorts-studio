import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  msToFlicks,
  secondsToFlicks,
  samplesToFlicks,
  TranscriptSchema,
  type Segment,
  type Transcript,
  type Word,
} from "../../../core/src/index.ts";
import { paths } from "../env.ts";
import { run, type RunOptions } from "../proc.ts";
import { tool } from "../tools.ts";

interface WToken {
  text: string;
  offsets: { from: number; to: number };
  id: number;
  p: number;
  t_dtw?: number;
}

interface WSegment {
  offsets: { from: number; to: number };
  text: string;
  tokens?: WToken[];
}

interface WJson {
  result?: { language?: string };
  transcription: WSegment[];
}

export interface WhisperOptions {
  /** Model name, e.g. "base.en", "small", "large-v3-turbo-q5_0". */
  model: string;
  /** ISO code or "auto". English-only models force "en". */
  language: string;
  threads?: number;
  /** DTW alignment preset name (e.g. "base.en", "small") for tighter token timestamps. */
  dtw?: string | null;
  vadModel?: string | null;
  prompt?: string;
}

/** Bump when word extraction changes so cached transcripts are rebuilt. */
export const WHISPER_ADAPTER_VERSION = "5";

export function whisperModelPath(model: string): string {
  return join(paths().modelsDir, "whisper", `ggml-${model}.bin`);
}

const SPECIAL = /^\s*(\[_[A-Z]+_?\d*\]|<\|[^|]*\|>|\[BLANK_AUDIO\])\s*$/;
const NON_SPEECH = /^\s*[[(][^\])]*[\])]\s*$/;

/** Builds words from whisper.cpp tokens: a leading space starts a word; punctuation attaches. */
export function wordsFromWhisper(json: WJson, opts: { useDtw: boolean }): { segments: Segment[]; words: Word[]; notes: string[] } {
  const segments: Segment[] = [];
  const words: Word[] = [];
  const notes: string[] = [];
  let wi = 0;
  let remapped = 0;
  json.transcription.forEach((seg, si) => {
    const segId = `seg${String(si + 1).padStart(5, "0")}`;
    let tokens = (seg.tokens ?? []).filter((t) => !SPECIAL.test(t.text) && t.text.length > 0);
    // whisper.cpp 1.9.x with --vad maps segment offsets to the source timeline but leaves
    // token offsets on the silence-stripped VAD timeline. Re-anchor tokens to their segment.
    const firstTok = tokens[0];
    if (firstTok && Math.abs(firstTok.offsets.from - seg.offsets.from) > 500) {
      const delta = seg.offsets.from - firstTok.offsets.from;
      tokens = tokens.map((t) => ({ ...t, offsets: { from: t.offsets.from + delta, to: t.offsets.to + delta }, ...(typeof t.t_dtw === "number" && t.t_dtw >= 0 ? { t_dtw: t.t_dtw + delta / 10 } : {}) }));
      remapped++;
    }
    type Acc = { text: string; from: number; to: number; ps: number[]; dtw: number | null };
    const acc: Acc[] = [];
    for (const t of tokens) {
      const trimmed = t.text.trim();
      if (!trimmed) continue;
      const isPunct = /^[^\p{L}\p{N}]+$/u.test(trimmed);
      const dtw = opts.useDtw && typeof t.t_dtw === "number" && t.t_dtw >= 0 ? t.t_dtw * 10 : null;
      const last = acc[acc.length - 1];
      // Dialogue dashes / ellipses with no word yet are speaker-turn markers, not speech.
      if (!last && isPunct) {
        if (/^[-–—.…]+$/.test(trimmed)) continue;
      }
      const startsWord = !last || (t.text.startsWith(" ") && !isPunct);
      if (startsWord) {
        acc.push({ text: trimmed, from: t.offsets.from, to: t.offsets.to, ps: [t.p], dtw });
      } else {
        // sub-word piece or punctuation: attach to the current word
        last!.text += isPunct ? trimmed : t.text;
        last!.to = Math.max(last!.to, t.offsets.to);
        if (!isPunct) last!.ps.push(t.p);
      }
    }
    const segWordIds: string[] = [];
    acc.forEach((a, i) => {
      const text = a.text.trim();
      if (!text) return;
      if (NON_SPEECH.test(text)) {
        notes.push(`non-speech annotation "${text}" at ${(a.from / 1000).toFixed(2)}s kept out of words`);
        return;
      }
      let start = a.dtw ?? a.from;
      const nextDtw = acc[i + 1]?.dtw ?? null;
      let end = a.dtw !== null && nextDtw !== null ? Math.min(a.to, Math.max(start + 40, nextDtw)) : a.to;
      if (end <= start) end = start + 40;
      start = Math.max(0, start);
      const conf = Math.min(...a.ps);
      const id = `w${String(++wi).padStart(6, "0")}`;
      segWordIds.push(id);
      words.push({
        id,
        text,
        start: msToFlicks(start),
        end: msToFlicks(end),
        confidence: Math.max(0, Math.min(1, conf)),
        segmentId: segId,
        uncertain: conf < 0.5,
        flags: conf < 0.5 ? ["low-confidence"] : [],
      });
    });
    if (segWordIds.length > 0) {
      const segWords = words.slice(words.length - segWordIds.length);
      segments.push({
        id: segId,
        start: segWords[0]!.start,
        end: segWords[segWords.length - 1]!.end,
        text: seg.text.trim(),
        wordIds: segWordIds,
      });
    }
  });
  if (remapped > 0) notes.push(`${remapped} segment(s) had token offsets on a different timeline than their segment (whisper VAD); tokens were re-anchored to segment start times`);
  // Enforce monotonic, non-overlapping word times (DTW can produce tiny inversions).
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1]!;
    const cur = words[i]!;
    if (cur.start < prev.end) {
      if (cur.start >= prev.start) prev.end = Math.max(prev.start + msToFlicks(20), cur.start);
      else words[i] = { ...cur, start: prev.end, end: Math.max(cur.end, prev.end + msToFlicks(20)), flags: [...cur.flags, "time-adjusted"] };
    }
  }
  return { segments, words, notes };
}

async function whisperVersion(bin: string): Promise<string> {
  const r = await run([bin, "--help"], { allowFailure: true, timeoutMs: 30_000 });
  const m = /version[: ]+v?([\d.]+)/i.exec(r.stdout + r.stderr);
  return m?.[1] ?? "1.9.4";
}

/**
 * Transcribes a 16 kHz mono WAV aligned to source time zero. Word times are
 * source timestamps; they are later retimed through the EditPlan time map.
 */
export async function transcribeWhisperCpp(
  sourceId: string,
  wav16k: string,
  workDir: string,
  opts: WhisperOptions,
  runOpts: RunOptions & { onProgress?: (pct: number) => void } = {},
): Promise<Transcript> {
  const bin = tool("whisper-cli");
  const model = whisperModelPath(opts.model);
  if (!existsSync(model)) throw new Error(`whisper model ${opts.model} not found at ${model}; run \`shorts-studio doctor --setup --models ${opts.model}\``);
  mkdirSync(workDir, { recursive: true });
  const prefix = join(workDir, "whisper");
  const englishOnly = opts.model.endsWith(".en");
  const language = englishOnly ? "en" : opts.language;
  const args = [bin, "-m", model, "-f", wav16k, "-l", language, "-t", String(opts.threads ?? 4), "-ojf", "-of", prefix, "-pp", "-mc", "64", "-nth", "0.6"];
  if (opts.dtw) args.push("--dtw", opts.dtw);
  if (opts.vadModel && existsSync(opts.vadModel)) args.push("--vad", "-vm", opts.vadModel);
  if (opts.prompt) args.push("--prompt", opts.prompt);
  const started = performance.now();
  await run(args, {
    timeoutMs: 12 * 3600_000,
    ...runOpts,
    onStderrLine: (l) => {
      const m = /progress\s*=\s*(\d+)%/.exec(l);
      if (m && runOpts.onProgress) runOpts.onProgress(Number(m[1]) / 100);
    },
  });
  const json = JSON.parse(readFileSync(`${prefix}.json`, "utf8")) as WJson;
  const { segments, words, notes } = wordsFromWhisper(json, { useDtw: Boolean(opts.dtw) });
  const detected = json.result?.language ?? language;
  const durationMs = words.length ? words[words.length - 1]!.end / 705_600 : 0;
  const transcript: Transcript = {
    schemaVersion: 1,
    sourceId,
    engine: {
      name: "whisper.cpp",
      version: await whisperVersion(bin),
      model: opts.model,
      params: { language, dtw: opts.dtw ?? null, vad: Boolean(opts.vadModel), threads: opts.threads ?? 4, maxContext: 64, wallSeconds: Math.round((performance.now() - started) / 1000) },
      device: "cpu",
    },
    language: detected,
    languageSource: opts.language === "auto" && !englishOnly ? "detected" : "user",
    durationFlicks: msToFlicks(durationMs),
    segments,
    words,
    speakers: [],
    diarization: null,
    createdAt: new Date().toISOString(),
    notes: [
      ...notes,
      "Word times come from whisper.cpp token timestamps" + (opts.dtw ? " refined with DTW alignment" : "") + "; they are measurements with ~20–80 ms typical error, verified later against the final voice track.",
    ],
  };
  return TranscriptSchema.parse(transcript);
}


export interface AudioChunk {
  path: string;
  startSample: number;
  endSample: number;
  /** Measured speech extent inside the chunk (source seconds), from our VAD. */
  speechStartS?: number;
  speechEndS?: number;
}

/**
 * whisper.cpp token timestamps drift late at the end of a chunk (measured up to ~0.8 s,
 * sometimes past the audio). Words that overrun the chunk's measured speech end are
 * remapped monotonically back inside it, keeping a minimum duration per word.
 */
export function constrainChunkTail(ws: Word[], speechEnd: number, slack = msToFlicks(80)): number {
  if (ws.length === 0) return 0;
  const limit = speechEnd + slack;
  const last = ws[ws.length - 1]!;
  if (last.end <= limit + msToFlicks(150) && last.start < limit) return 0;
  const minDur = (w: Word) => msToFlicks(Math.max(90, 45 * w.text.replace(/[^\p{L}\p{N}]/gu, "").length));
  let k = ws.length - 1;
  let need = minDur(ws[k]!);
  while (k > 0 && ws[k]!.start > limit - need) {
    k--;
    need += minDur(ws[k]!);
  }
  const a = ws[k]!.start;
  const b = Math.max(last.end, last.start + minDur(last));
  if (b <= a || limit <= a) return 0;
  const f = (limit - a) / (b - a);
  for (let i = k; i < ws.length; i++) {
    const w = ws[i]!;
    const start = a + (w.start - a) * f;
    const end = Math.max(start + msToFlicks(40), a + (Math.max(w.end, w.start + minDur(w)) - a) * f);
    ws[i] = { ...w, start: Math.round(start), end: Math.round(Math.min(end, limit)), flags: [...w.flags.filter((x) => x !== "time-adjusted"), "time-adjusted"] };
  }
  return ws.length - k;
}

/**
 * Transcribes VAD chunks in a single whisper.cpp process (model loaded once) and
 * returns words on the source timeline: each chunk's word times are offset by the
 * chunk's exact start sample. Chunks never cut inside speech (see audio/chunks.py).
 */
export async function transcribeChunksWhisperCpp(
  sourceId: string,
  chunks: AudioChunk[],
  rate: number,
  opts: WhisperOptions,
  runOpts: RunOptions & { onProgress?: (pct: number) => void } = {},
): Promise<Transcript> {
  const bin = tool("whisper-cli");
  const model = whisperModelPath(opts.model);
  if (!existsSync(model)) throw new Error(`whisper model ${opts.model} not found at ${model}; run \`shorts-studio doctor --setup --models ${opts.model}\``);
  const englishOnly = opts.model.endsWith(".en");
  const language = englishOnly ? "en" : opts.language;
  const started = performance.now();
  const words: Word[] = [];
  const segments: Segment[] = [];
  const notes: string[] = [];
  const languages = new Map<string, number>();
  // Batches keep argv size and memory bounded on long sources.
  const batchSize = 40;
  for (let b = 0; b < chunks.length; b += batchSize) {
    const batch = chunks.slice(b, b + batchSize);
    const args = [bin, "-m", model, "-l", language, "-t", String(opts.threads ?? 4), "-ojf", "-np", "-mc", "64"];
    if (opts.dtw) args.push("--dtw", opts.dtw);
    if (opts.prompt) args.push("--prompt", opts.prompt);
    args.push(...batch.map((c) => c.path));
    await run(args, { timeoutMs: 12 * 3600_000, ...runOpts });
    runOpts.onProgress?.(Math.min(1, (b + batch.length) / chunks.length));
    for (const [k, c] of batch.entries()) {
      const jsonPath = `${c.path}.json`;
      if (!existsSync(jsonPath)) {
        notes.push(`chunk ${b + k + 1} produced no output`);
        continue;
      }
      const json = JSON.parse(readFileSync(jsonPath, "utf8")) as WJson;
      const lang = json.result?.language ?? language;
      languages.set(lang, (languages.get(lang) ?? 0) + 1);
      const parsed = wordsFromWhisper(json, { useDtw: Boolean(opts.dtw) });
      const offset = samplesToFlicks(c.startSample, rate);
      const limit = samplesToFlicks(c.endSample, rate);
      const idMap = new Map<string, string>();
      const chunkWords: Word[] = parsed.words.map((w) => ({ ...w, start: w.start + offset, end: w.end + offset }));
      const speechEnd = c.speechEndS !== undefined ? Math.min(secondsToFlicks(c.speechEndS), limit) : limit;
      const adjusted = constrainChunkTail(chunkWords, speechEnd);
      if (adjusted) notes.push(`chunk ${b + k + 1}: last ${adjusted} word(s) overran the measured speech end (${(c.speechEndS ?? 0).toFixed(2)} s) and were re-timed inside it`);
      for (const w of chunkWords) {
        const id = `w${String(words.length + 1).padStart(6, "0")}`;
        idMap.set(w.id, id);
        const end = Math.min(w.end, limit);
        words.push({ ...w, id, start: Math.min(w.start, end - msToFlicks(40)), end, segmentId: `c${b + k + 1}-${w.segmentId}` });
      }
      for (const sg of parsed.segments) {
        segments.push({
          ...sg,
          id: `c${b + k + 1}-${sg.id}`,
          start: sg.start + offset,
          end: Math.min(sg.end + offset, limit),
          wordIds: sg.wordIds.map((id) => idMap.get(id)!).filter(Boolean),
          ...(lang ? { language: lang } : {}),
        });
      }
      notes.push(...parsed.notes.map((n) => `chunk ${b + k + 1}: ${n}`));
    }
  }
  const detected = [...languages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? language;
  if (languages.size > 1) notes.push(`languages detected per chunk: ${[...languages.entries()].map(([l, n]) => `${l}×${n}`).join(", ")} (speech is not translated)`);
  const last = words[words.length - 1];
  return TranscriptSchema.parse({
    schemaVersion: 1,
    sourceId,
    engine: {
      name: "whisper.cpp",
      version: await whisperVersion(bin),
      model: opts.model,
      params: { language, mode: "vad-chunked", chunks: chunks.length, dtw: opts.dtw ?? null, threads: opts.threads ?? 4, maxContext: 64, wallSeconds: Math.round((performance.now() - started) / 1000) },
      device: "cpu",
    },
    language: detected,
    languageSource: opts.language === "auto" && !englishOnly ? "detected" : "user",
    durationFlicks: last ? last.end : 0,
    segments,
    words,
    speakers: [],
    diarization: null,
    createdAt: new Date().toISOString(),
    notes: [
      ...notes,
      "VAD-chunked transcription: chunk boundaries fall in measured pauses; word times are whisper.cpp token timestamps offset to the source clock (typical error 20–80 ms), re-verified against the final voice track at QA.",
    ],
  });
}
