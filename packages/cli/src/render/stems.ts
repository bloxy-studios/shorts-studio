import { join } from "node:path";
import { flicksPerSample, flicksToSeconds, type EditPlan, type StemMeasurement } from "../../../core/src/index.ts";
import { py } from "../../../adapters/src/python.ts";
import { stage } from "../ui.ts";

interface PyStem {
  path: string;
  durationSamples: number;
  sampleRate: number;
  channels: number;
  integratedLufs: number | null;
  samplePeakDbfs: number | null;
  truePeakDbtp: number | null;
  note: string | null;
}

export interface SynthStems {
  stems: Record<string, string>;
  measurements: Record<string, StemMeasurement>;
  placements: unknown[];
  music: Record<string, unknown> | null;
}

/**
 * Renders the code-synthesized stems the plan asks for (music bed, SFX, riser) at
 * END length. Event levels are relative to the voice-stem peak; the music bed gets
 * one flat gain to its LUFS target (no ducking/automation unless a preset allows it).
 */
export async function renderSynthStems(plan: EditPlan, dir: string, voicePeakDbfs: number): Promise<SynthStems> {
  const sample = flicksPerSample(plan.output.sampleRate);
  const endSamples = Math.round(plan.output.durationFlicks / sample);
  const stems: Record<string, string> = {};
  const measurements: Record<string, StemMeasurement> = {};
  let placements: unknown[] = [];
  let music: Record<string, unknown> | null = null;
  const m = plan.audio.music;
  if (m.mode === "synth") {
    stage("audio", `synthesizing music bed (${m.bpm} BPM, key ${m.key}, seed ${m.seed}, target ${m.targetLufs} LUFS${m.gainDb ? ` ${m.gainDb > 0 ? "+" : ""}${m.gainDb} dB revision` : ""})`);
    const out = join(dir, "stems", "music.wav");
    const r = await py<PyStem & Record<string, unknown>>("synth.music", {
      endSamples,
      fpsNum: plan.output.fps.num,
      fpsDen: plan.output.fps.den,
      bpm: m.bpm,
      key: m.key,
      seed: m.seed,
      targetLufs: m.targetLufs ?? -24,
      gainDb: m.gainDb ?? 0,
      fadeOutMs: flicksToSeconds(m.fadeOutFlicks) * 1000 || 800,
      declickMs: flicksToSeconds(m.declickFlicks) * 1000 || 5,
      out,
    });
    stems.music = out;
    music = r;
    measurements.music = { path: out, durationSamples: r.durationSamples, sampleRate: r.sampleRate, channels: r.channels, integratedLufs: r.integratedLufs, samplePeakDbfs: r.samplePeakDbfs, truePeakDbtp: r.truePeakDbtp, ...(r.note ? { note: r.note } : {}) };
  }
  const events = [
    ...plan.audio.sfx.map((e) => ({ id: e.id, tSamples: Math.round(e.t / sample), kind: e.kind, variant: e.variant, relPeakDb: e.relPeakDb })),
    ...(plan.audio.riser?.enabled ? [{ id: "riser", tSamples: Math.round(plan.audio.riser.endFlicks / sample), kind: "riser", variant: 0, relPeakDb: plan.audio.riser.relPeakDb, durationS: flicksToSeconds(plan.audio.riser.durationFlicks) }] : []),
  ];
  if (events.length) {
    stage("audio", `synthesizing ${plan.audio.sfx.length} SFX event(s)${plan.audio.riser?.enabled ? " + intro riser" : ""}`);
    const r = await py<{ sfx: PyStem; riser: PyStem; placements: unknown[] }>("synth.events", {
      events,
      endSamples,
      voicePeakDbfs,
      seed: plan.audio.music.seed,
      sfxOut: join(dir, "stems", "sfx.wav"),
      riserOut: join(dir, "stems", "riser.wav"),
    });
    for (const k of ["sfx", "riser"] as const) {
      const s = r[k];
      stems[k] = s.path;
      measurements[k] = { path: s.path, durationSamples: s.durationSamples, sampleRate: s.sampleRate, channels: s.channels, integratedLufs: s.integratedLufs, samplePeakDbfs: s.samplePeakDbfs, truePeakDbtp: s.truePeakDbtp, ...(s.note ? { note: s.note } : {}) };
    }
    placements = r.placements;
  }
  return { stems, measurements, placements, music };
}
