import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { flicksPerSample, type EditPlan, type SourceAsset, type StemMeasurement } from "../../../core/src/index.ts";
import { py } from "../../../adapters/src/python.ts";
import { run } from "../../../adapters/src/proc.ts";
import { tool } from "../../../adapters/src/tools.ts";
import { stage } from "../ui.ts";
import { renderSynthStems } from "./stems.ts";

interface PyMeasure {
  path: string;
  durationSamples: number;
  sampleRate: number;
  channels: number;
  integratedLufs: number | null;
  samplePeakDbfs: number | null;
  truePeakDbtp: number | null;
  note: string | null;
}

export async function measureFiles(files: Record<string, string>): Promise<Record<string, StemMeasurement>> {
  const res = await py<{ measurements: Record<string, PyMeasure> }>("audio.loudness", { files });
  const out: Record<string, StemMeasurement> = {};
  for (const [k, m] of Object.entries(res.measurements)) {
    out[k] = {
      path: m.path,
      durationSamples: m.durationSamples,
      sampleRate: m.sampleRate,
      channels: m.channels,
      integratedLufs: m.integratedLufs,
      samplePeakDbfs: m.samplePeakDbfs,
      truePeakDbtp: m.truePeakDbtp,
      ...(m.note ? { note: m.note } : {}),
    };
  }
  return out;
}

/** Margin for AAC true-peak overshoot (measured ~0.38 dB on the first render). */
export const AAC_HEADROOM_DB = 0.6;

async function ffFilter(input: string, output: string, af: string): Promise<void> {
  await run([tool("ffmpeg"), "-hide_banner", "-nostdin", "-y", "-v", "error", "-i", input, "-af", af, "-ar", "48000", "-c:a", "pcm_s24le", output], { timeoutMs: 3600_000 });
}

/** True-peak-aware limiting: oversample 4x, limit below the ceiling, return to 48 kHz. */
async function truePeakLimit(input: string, output: string, ceilingDbtp: number): Promise<void> {
  const limit = 10 ** ((ceilingDbtp - 0.3) / 20);
  await ffFilter(input, output, `aresample=192000,alimiter=limit=${limit.toFixed(4)}:attack=2:release=60:level=disabled,aresample=48000`);
}

export interface AudioStageResult {
  stems: Record<string, StemMeasurement>;
  master: StemMeasurement;
  masterPath: string;
  log: string[];
  sfxPlacements: unknown[];
  music: Record<string, unknown> | null;
}

/**
 * Builds END-length 48 kHz stems from the plan, applies the voice chain and a
 * static gain toward the loudness target, sums stems at unity into the master,
 * and measures everything. Stem levels are never silently renormalized after
 * mixing; a master limiter is applied only if true peak exceeds the ceiling.
 */
export async function renderAudio(plan: EditPlan, sources: Map<string, SourceAsset>, dir: string, extraStems: Record<string, string> = {}): Promise<AudioStageResult> {
  const log: string[] = [];
  const sample = flicksPerSample(plan.output.sampleRate);
  const endSamples = Math.round(plan.output.durationFlicks / sample);
  const stemsDir = join(dir, "stems");
  const work = join(dir, "work");
  mkdirSync(stemsDir, { recursive: true });
  mkdirSync(work, { recursive: true });

  stage("audio", `assembling voice stem (${endSamples} samples @ ${plan.output.sampleRate} Hz)`);
  const clips = plan.segments.flatMap((seg) =>
    seg.audio.map((a) => {
      const src = sources.get(a.sourceId);
      if (!src?.derived.audio48k) throw new Error(`source ${a.sourceId} has no 48 kHz audio`);
      return {
        id: `${seg.id}.${a.id}`,
        sourcePath: src.derived.audio48k.path,
        srcStartSamples: Math.round(a.srcStart / sample),
        outStartSamples: Math.round(a.outStart / sample),
        lengthSamples: Math.round((a.outEnd - a.outStart) / sample),
        fadeInSamples: Math.round(a.fadeInFlicks / sample),
        fadeOutSamples: Math.round(a.fadeOutFlicks / sample),
        gainDb: a.gainDb,
      };
    }),
  );
  const raw = join(work, "voice_raw.wav");
  const asm = await py<{ peak: number; overload: boolean; clips: Array<{ id: string; missingSamples: number }> }>("audio.assemble", {
    clips,
    endSamples,
    rate: plan.output.sampleRate,
    channels: plan.output.audioChannels,
    out: raw,
  });
  if (asm.overload) log.push(`voice assembly peaked at ${(20 * Math.log10(asm.peak)).toFixed(2)} dBFS (overload) before processing`);
  for (const c of asm.clips) if (c.missingSamples > 0) log.push(`clip ${c.id} ran past the source end by ${c.missingSamples} samples (padded with silence)`);

  // Voice chain: full chain for clean voice recordings; source mixes only get a high-pass.
  const chain = plan.audio.voice.chain;
  const isMix = plan.audio.sourceAudioPolicy === "keep-source-mix";
  const filters: string[] = [];
  if (chain.highpassHz) filters.push(`highpass=f=${chain.highpassHz}:poles=2`);
  if (!isMix) {
    if (chain.denoise === "light") filters.push("afftdn=nr=6:nf=-55:tn=1");
    if (chain.denoise === "medium") filters.push("afftdn=nr=12:nf=-50:tn=1");
    if (chain.deess) filters.push("deesser=i=0.35:m=0.5:f=0.5:s=o");
    if (chain.compress) filters.push("acompressor=threshold=-20dB:ratio=2.5:attack=8:release=120:knee=4:makeup=1");
  }
  const processed = join(work, "voice_proc.wav");
  if (filters.length > 0) {
    stage("audio", `voice chain: ${filters.map((f) => f.split("=")[0]).join(" → ")}${isMix ? " (source mix: high-pass only)" : ""}`);
    await ffFilter(raw, processed, filters.join(","));
  } else {
    copyFileSync(raw, processed);
  }

  // Static gain to the voice target, measured before and after.
  let before = (await measureFiles({ voice: processed })).voice!;
  const voicePath = join(stemsDir, "voice.wav");
  const target = chain.targetLufs;
  const ceiling = plan.audio.master.maxTruePeakDbtp;
  // AAC encoding overshoots true peak by ~0.2–0.5 dB; limit stems/master below the
  // delivery ceiling so the encoded file (what QA measures) stays compliant.
  const headroom = plan.audio.master.aacHeadroomDb ?? AAC_HEADROOM_DB;
  const encodeCeiling = ceiling - headroom;
  if (target !== null && before.integratedLufs !== null && before.truePeakDbtp !== null) {
    // If reaching the target would need more than ~4 dB of peak limiting, tame the
    // crest factor first with a gentle speech compressor (logged, re-measured).
    const projectedTp = before.truePeakDbtp + (target - before.integratedLufs);
    if (projectedTp - ceiling > 4) {
      const compressed = join(work, "voice_comp.wav");
      log.push(`reaching ${target} LUFS from ${before.integratedLufs.toFixed(2)} LUFS would need ${(projectedTp - ceiling).toFixed(1)} dB of peak limiting; applied a gentle compressor first (threshold -26 dB, 3:1, 6 dB knee)`);
      await ffFilter(processed, compressed, "acompressor=threshold=-26dB:ratio=3:attack=6:release=160:knee=6:makeup=1");
      before = (await measureFiles({ voice: compressed })).voice!;
      copyFileSync(compressed, processed);
    }
  }
  if (target !== null && before.integratedLufs !== null) {
    const gain = target - before.integratedLufs;
    stage("audio", `voice ${before.integratedLufs.toFixed(2)} LUFS → target ${target} (static gain ${gain >= 0 ? "+" : ""}${gain.toFixed(2)} dB)`);
    const gained = join(work, "voice_gain.wav");
    await ffFilter(processed, gained, `volume=${gain.toFixed(3)}dB`);
    const mid = (await measureFiles({ v: gained })).v!;
    if (mid.truePeakDbtp !== null && mid.truePeakDbtp > encodeCeiling) {
      log.push(`voice true peak ${mid.truePeakDbtp.toFixed(2)} dBTP after gain exceeded the pre-encode ceiling ${encodeCeiling.toFixed(1)} dBTP (${ceiling} dBTP delivery − ${headroom} dB AAC headroom): oversampled limiter applied to the voice stem`);
      await truePeakLimit(gained, voicePath, encodeCeiling);
    } else {
      copyFileSync(gained, voicePath);
    }
  } else {
    copyFileSync(processed, voicePath);
    if (target !== null) log.push("voice loudness target skipped: integrated loudness undefined (silent or too short)");
  }

  // Synthesized stems (music bed, SFX, riser) are levelled relative to the finished voice stem.
  const voiceNow = (await measureFiles({ v: voicePath })).v!;
  const synth = await renderSynthStems(plan, dir, voiceNow.samplePeakDbfs ?? -1);
  // Master: unity sum of stems (voice + any synthesized stems).
  const stemFiles: Record<string, string> = { voice: voicePath, ...synth.stems, ...extraStems };
  const masterRaw = join(work, "master_sum.wav");
  const inputs = Object.values(stemFiles);
  if (inputs.length === 1) copyFileSync(voicePath, masterRaw);
  else {
    const args = [tool("ffmpeg"), "-hide_banner", "-nostdin", "-y", "-v", "error"];
    for (const f of inputs) args.push("-i", f);
    args.push("-filter_complex", `${inputs.map((_, i) => `[${i}:a]`).join("")}amix=inputs=${inputs.length}:duration=first:dropout_transition=0:normalize=0[m]`, "-map", "[m]", "-ar", "48000", "-c:a", "pcm_s24le", masterRaw);
    await run(args, { timeoutMs: 3600_000 });
  }
  const masterPath = join(dir, "master.wav");
  const m0 = (await measureFiles({ m: masterRaw })).m!;
  if (m0.truePeakDbtp !== null && m0.truePeakDbtp > encodeCeiling && plan.audio.master.limiter === "if-needed") {
    log.push(`master true peak ${m0.truePeakDbtp.toFixed(2)} dBTP exceeded the pre-encode ceiling ${encodeCeiling.toFixed(1)} dBTP: oversampled limiter applied to the master only (stems unchanged)`);
    await truePeakLimit(masterRaw, masterPath, encodeCeiling);
  } else {
    copyFileSync(masterRaw, masterPath);
  }
  const measured = await measureFiles({ ...stemFiles, master: masterPath });
  const { master, ...stems } = measured;
  if (!existsSync(masterPath)) throw new Error("master mix missing");
  return { stems, master: master!, masterPath, log, sfxPlacements: synth.placements, music: synth.music };
}
