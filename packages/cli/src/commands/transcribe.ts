import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  TranscriptSchema,
  flicksToSeconds,
  msToFlicks,
  readJsonIfExists,
  secondsToFlicks,
  transcriptCoverage,
  writeJson,
  type SourceAsset,
  type Transcript,
  type Word,
} from "../../../core/src/index.ts";
import { run } from "../../../adapters/src/proc.ts";
import { tool } from "../../../adapters/src/tools.ts";
import { ensureAudioFeatures } from "./analyze.ts";
import { WHISPER_ADAPTER_VERSION, transcribeChunksWhisperCpp, transcribeWhisperCpp, whisperModelPath, type AudioChunk } from "../../../adapters/src/asr/whispercpp.ts";
import { py } from "../../../adapters/src/python.ts";
import { P, type Project } from "../project.ts";
import { runStage, cancellation } from "../jobs.ts";
import { info, progressReporter, stage } from "../ui.ts";
import { loadSource } from "./ingest.ts";

export interface TranscribeOptions {
  sourceId: string;
  model?: string;
  language?: string;
  force?: boolean;
  /** "chunked" (default): VAD chunks; "full": one whole-file pass. */
  mode?: "chunked" | "full";
}

/**
 * Model choice: an explicit --model wins; otherwise English uses small.en/base.en
 * when present and any other or unknown language uses the multilingual model
 * (never silently an English-only model for non-English speech).
 */
export function chooseModel(language: string | undefined, explicit?: string): string {
  if (explicit) return explicit;
  const has = (m: string) => existsSync(whisperModelPath(m));
  if (language === "en") {
    for (const m of ["small.en", "base.en", "small"]) if (has(m)) return m;
  }
  for (const m of ["large-v3-turbo-q5_0", "small", "small-q5_1", "base"]) if (has(m)) return m;
  return language === "en" ? "base.en" : "small";
}

/**
 * Cross-checks the transcript against measured speech activity and re-transcribes
 * any uncovered speech windows (bounded), so dropped speech never passes silently.
 */
async function verifyCoverage(p: Project, src: SourceAsset, t: Transcript, model: string, language: string, signal: AbortSignal): Promise<Transcript> {
  const audio = await ensureAudioFeatures(p, src);
  if (!audio) return t;
  let cov = transcriptCoverage(t.words, audio.speech);
  const notes = [...t.notes];
  let words = [...t.words];
  let segments = [...t.segments];
  if (cov.uncovered.length > 0) {
    const windows = cov.uncovered.slice(0, 40);
    stage("transcribe", `coverage ${(cov.coveredFraction * 100).toFixed(1)}%: re-transcribing ${windows.length} uncovered speech window(s)`);
    const dir = join(P.analysis(p, src.id), "whisper", "gaps");
    mkdirSync(dir, { recursive: true });
    for (const [i, w] of windows.entries()) {
      const startS = Math.max(0, flicksToSeconds(w.start) - 0.4);
      const durS = flicksToSeconds(w.end - w.start) + 0.8;
      const wav = join(dir, `gap${i}.wav`);
      await run([tool("ffmpeg"), "-hide_banner", "-nostdin", "-y", "-v", "error", "-ss", startS.toFixed(3), "-t", durS.toFixed(3), "-i", src.derived.audio16k!.path, "-c:a", "pcm_s16le", wav], { signal });
      const g = await transcribeWhisperCpp(src.id, wav, join(dir, `gap${i}`), { model, language, threads: 4, dtw: null, vadModel: null }, { signal });
      const offset = secondsToFlicks(startS);
      const lo = w.start - msToFlicks(300);
      const hi = w.end + msToFlicks(300);
      const fresh = g.words
        .map((x) => ({ ...x, start: x.start + offset, end: x.end + offset, segmentId: `gap${i}-${x.segmentId}`, flags: [...x.flags, "gap-retranscribed"] }))
        .filter((x) => x.start >= lo && x.end <= hi && !words.some((e) => e.start < x.end && x.start < e.end));
      if (fresh.length > 0) {
        words = [...words, ...fresh];
        segments = [...segments, { id: `gap${i}`, start: fresh[0]!.start, end: fresh[fresh.length - 1]!.end, text: fresh.map((x) => x.text).join(" "), wordIds: fresh.map((x) => x.id) }];
      }
      notes.push(`gap ${i + 1}: ${flicksToSeconds(w.start).toFixed(2)}–${flicksToSeconds(w.end).toFixed(2)} s re-transcribed → ${fresh.length} word(s)`);
    }
    // Renumber words chronologically and remap segment references.
    words.sort((a, b) => a.start - b.start);
    const idMap = new Map<string, string>();
    const segOf = new Map<string, string>();
    for (const sg of segments) for (const id of sg.wordIds) segOf.set(`${sg.id}|${id}`, sg.id);
    const renumbered: Word[] = words.map((w, i) => {
      const id = `w${String(i + 1).padStart(6, "0")}`;
      idMap.set(`${w.segmentId.startsWith("gap") ? w.segmentId.split("-")[0] : w.segmentId}|${w.id}`, id);
      return { ...w, id, segmentId: w.segmentId.startsWith("gap") ? w.segmentId.split("-")[0]! : w.segmentId };
    });
    segments = segments
      .map((sg) => ({ ...sg, wordIds: sg.wordIds.map((id) => idMap.get(`${sg.id}|${id}`)).filter((x): x is string => Boolean(x)) }))
      .filter((sg) => sg.wordIds.length > 0)
      .sort((a, b) => a.start - b.start);
    words = renumbered;
    void segOf;
    cov = transcriptCoverage(words, audio.speech);
  }
  const outside = new Set(cov.outsideSpeechWordIds);
  words = words.map((w) => (outside.has(w.id) ? { ...w, uncertain: true, flags: [...new Set([...w.flags, "outside-speech"])] } : w));
  notes.push(`coverage: ${(cov.coveredFraction * 100).toFixed(1)}% of ${flicksToSeconds(cov.speechFlicks).toFixed(1)} s measured speech has transcribed words; ${cov.uncovered.length} uncovered region(s) remain; ${outside.size} word(s) lie outside measured speech (flagged)`);
  return TranscriptSchema.parse({ ...t, words, segments, notes, durationFlicks: Math.max(t.durationFlicks, words[words.length - 1]?.end ?? 0) });
}

export function transcriptPath(p: Project, sourceId: string): string {
  return join(P.analysis(p, sourceId), "transcript.json");
}

export function loadTranscript(p: Project, sourceId: string): Transcript | null {
  return readJsonIfExists(transcriptPath(p, sourceId), TranscriptSchema);
}

export async function transcribe(p: Project, opts: TranscribeOptions): Promise<Transcript> {
  const src = loadSource(p, opts.sourceId);
  if (!src.derived.audio16k) throw new Error(`${src.id} has no audio track to transcribe`);
  const language = opts.language ?? p.config.language ?? "auto";
  const model = chooseModel(language === "auto" ? undefined : language, opts.model);
  const out = transcriptPath(p, src.id);
  const res = await runStage(
    p,
    `transcribe.${src.id}`,
    { hash: src.contentHash, model, language, engine: "whisper.cpp", mode: opts.mode ?? "chunked", adapter: WHISPER_ADAPTER_VERSION },
    async (signal) => {
      const audio = await ensureAudioFeatures(p, src);
      let t: Transcript;
      if (audio && audio.speech.length > 0 && opts.mode !== "full") {
        const regions = audio.speech.map((r) => [flicksToSeconds(r.start), flicksToSeconds(r.end)]);
        const chunkDir = join(P.analysis(p, src.id), "whisper", "chunks");
        const plan = await py<{ rate: number; chunks: AudioChunk[]; speechSeconds: number }>("audio.chunks", { wav: src.derived.audio16k!.path, regions, outDir: chunkDir, maxChunkS: 28, mergeGapS: 0.8, padS: 0.25 });
        stage("transcribe", `whisper.cpp ${model} on ${plan.chunks.length} VAD chunk(s), ${plan.speechSeconds.toFixed(0)} s of speech (${language === "auto" ? "language auto-detect" : language})`);
        const report = progressReporter("transcribing");
        t = await transcribeChunksWhisperCpp(src.id, plan.chunks, plan.rate, { model, language, threads: 4, dtw: null, vadModel: null }, { signal, onProgress: (f) => report(f) });
      } else {
        stage("transcribe", `whisper.cpp ${model} full-file pass (${language === "auto" ? "language auto-detect" : language})`);
        const report = progressReporter("transcribing");
        // whisper's own VAD is off: with it, 1.9.x token times leave the source timeline.
        t = await transcribeWhisperCpp(src.id, src.derived.audio16k!.path, join(P.analysis(p, src.id), "whisper"), { model, language, threads: 4, dtw: null, vadModel: null }, { signal, onProgress: (f) => report(f) });
      }
      const checked = await verifyCoverage(p, src, t, model, language, signal);
      writeJson(out, checked);
      return { outputs: [out], value: checked };
    },
    { force: Boolean(opts.force) },
  );
  const t = res.value ?? loadTranscript(p, src.id)!;
  const low = t.words.filter((w) => w.uncertain).length;
  info(`  ✓ ${t.words.length} words, ${t.segments.length} segments, language ${t.language}; ${low} low-confidence word(s) flagged`);
  void cancellation;
  return t;
}
