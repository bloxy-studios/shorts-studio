import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { flicksPerFrame, flicksToMs, formatRational, formatTimecode, type EditPlan, type QAReport, type RenderRecord, type SourceAsset, type Transcript } from "../../core/src/index.ts";
import type { CaptionBand } from "./render/pipeline.ts";
import type { Coverage } from "../../core/src/index.ts";

const tc = (f: number) => formatTimecode(f);
const ms = (f: number) => `${flicksToMs(f).toFixed(1)} ms`;
const fmtDb = (v: number | null | undefined, unit: string) => (v === null || v === undefined ? "n/a" : `${v.toFixed(2)} ${unit}`);

export interface ReportInput {
  plan: EditPlan;
  record: RenderRecord;
  qa: QAReport;
  sources: Map<string, SourceAsset>;
  transcript: Transcript | null;
  coverage: Coverage | null;
  captions: CaptionBand | null;
  dir: string;
  planNotes?: string[];
}

/** Short, readable report another editor can use to understand and revise the result. */
export function writeReport(r: ReportInput): string {
  const { plan, record, qa } = r;
  const frame = flicksPerFrame(plan.output.fps);
  const lines: string[] = [];
  const verdictLine = {
    pass: "PASS — all automated checks passed",
    "pass-with-warnings": "PASS WITH WARNINGS — no hard failures; see findings",
    draft: "DRAFT — hard failures remain (see findings)",
    blocked: "BLOCKED — hard failures remain; not a deliverable",
  }[qa.summary.verdict];
  lines.push(`# ${plan.clipId} · render ${record.id} · plan v${plan.version}`);
  lines.push("");
  lines.push(`**QA verdict:** ${verdictLine}. ${qa.summary.passed} passed, ${qa.summary.warnings} warning(s), ${qa.summary.hardFailures} hard failure(s). Visual review of the frame sheets is ${qa.inspection.some((i) => i.how === "agent-visual") ? "recorded below" : "still pending"}.`);
  lines.push("");
  lines.push("## Deliverables");
  for (const [k, v] of Object.entries(record.paths)) lines.push(`- ${k}: \`${v}\``);
  lines.push("");
  lines.push("## Source");
  for (const s of r.sources.values()) {
    lines.push(`- ${s.id}: ${s.provenance.attribution}${s.provenance.license ? ` — license: ${s.provenance.license}` : ""}`);
    const v = s.probe.video;
    lines.push(`  ${(s.probe.durationFlicks / 705_600_000).toFixed(2)} s${v ? `, ${v.displayWidth}x${v.displayHeight} @ ${formatRational(v.fps)} fps${v.isVFR ? " VFR" : ""}, ${v.colorPrimaries ?? "untagged"}` : ""}; acquisition ${s.acquisition.status}${s.acquisition.tool ? ` via ${s.acquisition.tool} ${s.acquisition.toolVersion ?? ""}` : ""}`);
  }
  if (r.coverage) {
    lines.push(`- Analysis coverage: transcript ${r.coverage.transcript}, visual ${r.coverage.visual}, audio ${r.coverage.audio}; ${r.coverage.framesSampled} frames sampled.`);
    for (const l of r.coverage.limitations) lines.push(`  - limitation: ${l}`);
  }
  if (r.transcript) lines.push(`- Transcript: ${r.transcript.engine.name} ${r.transcript.engine.model}, language ${r.transcript.language} (${r.transcript.languageSource}); ${r.transcript.words.filter((w) => w.uncertain).length} uncertain word(s) flagged.`);
  lines.push("");
  lines.push("## Timing");
  lines.push(`- Output: ${plan.output.width}x${plan.output.height} @ ${formatRational(plan.output.fps)} fps, ${plan.output.sampleRate} Hz.`);
  lines.push(`- Exact final voice sample: ${ms(plan.output.voiceEndFlicks)}; frame-aligned END: ${ms(plan.output.durationFlicks)} = ${plan.output.frameCount} frames.`);
  if (plan.sourceRange) lines.push(`- Source range: ${tc(plan.sourceRange.start)} → ${tc(plan.sourceRange.end)} of ${plan.sourceRange.sourceId}.`);
  lines.push("");
  lines.push("| segment | output | source | words |");
  lines.push("| --- | --- | --- | --- |");
  for (const s of plan.segments) {
    lines.push(`| ${s.id} | ${tc(s.picture.outStart)}–${tc(s.picture.outEnd)} | ${s.picture.sourceId} ${tc(s.picture.srcStart)}–${tc(s.picture.srcStart + s.picture.outEnd - s.picture.outStart)} | ${s.wordIds.length} |`);
  }
  lines.push("");
  lines.push("## Layout runs");
  lines.push("| run | output | frames | layout | caption zone | reason |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const run of plan.layoutRuns) {
    lines.push(`| ${run.id} | ${tc(run.outStart)}–${tc(run.outEnd)} | ${(run.outEnd - run.outStart) / frame} | ${run.layout} | y ${run.captionZone.y0}–${run.captionZone.y1} | ${run.reason}${run.exceptions.length ? ` (exceptions: ${run.exceptions.join("; ")})` : ""} |`);
  }
  lines.push("");
  lines.push("## Framing");
  for (const c of plan.cropPaths) {
    const b = c.keyframes[0]!.box;
    lines.push(`- ${c.id} (${c.slot}): ${c.interpolation === "hold" ? "static" : `${c.keyframes.length} keyframes, ${c.interpolation}`} crop x=${b.x.toFixed(0)} y=${b.y.toFixed(0)} ${b.w.toFixed(0)}x${b.h.toFixed(0)}; confidence ${c.confidence.toFixed(2)}; ${c.reason}`);
  }
  if (plan.fallbacks.length) for (const f of plan.fallbacks) lines.push(`- fallback: ${f.capability} → ${f.fallback} (${f.reason})`);
  lines.push("");
  if (plan.captions) {
    const cap = plan.captions;
    const highlighted = cap.chunks.flatMap((c) => c.words.filter((w) => w.emphasis === "highlight").map((w) => w.display));
    lines.push("## Captions");
    lines.push(`- Style ${cap.styleId} v${cap.styleVersion}; ${cap.chunks.length} chunks; first caption at ${ms(cap.chunks[0]?.outStart ?? 0)}; retimed from the EditPlan time map (not raw transcript times).`);
    if (r.captions) lines.push(`- Rendered as ${r.captions.states.length} HyperFrames state frame(s) and composited frame-exactly into a band at y=${r.captions.bandY}–${r.captions.bandY + r.captions.bandHeight}.`);
    if (highlighted.length) lines.push(`- Emphasized words: ${highlighted.join(", ")}.`);
    const unc = cap.chunks.flatMap((c) => c.words.filter((w) => w.uncertain).map((w) => `${w.display} @ ${tc(w.outStart)}`));
    lines.push(`- Uncertain words shown as transcribed (review): ${unc.length ? unc.join(", ") : "none"}.`);
    lines.push(`- Exports: SRT/VTT contain spoken words only; authored titles are never exported as speech.`);
    lines.push("");
  }
  lines.push("## Audio");
  lines.push(`- Policy: ${plan.audio.sourceAudioPolicy}; voice chain ${JSON.stringify(plan.audio.voice.chain)}; music ${plan.audio.music.mode}; ${plan.audio.sfx.length} SFX event(s).`);
  lines.push("| stem | samples | integrated | sample peak | true peak | note |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const [k, s] of Object.entries(record.stems)) lines.push(`| ${k} | ${s.durationSamples} | ${fmtDb(s.integratedLufs, "LUFS")} | ${fmtDb(s.samplePeakDbfs, "dBFS")} | ${fmtDb(s.truePeakDbtp, "dBTP")} | ${s.note ?? ""} |`);
  if (record.master) lines.push(`| master | ${record.master.durationSamples} | ${fmtDb(record.master.integratedLufs, "LUFS")} | ${fmtDb(record.master.samplePeakDbfs, "dBFS")} | ${fmtDb(record.master.truePeakDbtp, "dBTP")} | ${record.master.note ?? ""} |`);
  lines.push("");
  lines.push("## QA findings");
  for (const f of qa.findings) lines.push(`- [${f.status.toUpperCase()}] ${f.check} (${f.severity}): ${f.message}${f.repair ? ` → repair: ${f.repair.action}` : ""}`);
  lines.push("");
  lines.push("## Inspection record");
  for (const i of qa.inspection) lines.push(`- ${i.what}: ${i.how}${i.artifact ? ` (\`${i.artifact}\`)` : ""} — ${i.notes}`);
  if (r.planNotes?.length) {
    lines.push("");
    lines.push("## Planner notes");
    for (const n of r.planNotes) lines.push(`- ${n}`);
  }
  if (plan.decisions.length) {
    lines.push("");
    lines.push("## Decisions");
    for (const d of plan.decisions) lines.push(`- ${d.key} = ${JSON.stringify(d.value)} (${d.layer}): ${d.reason}`);
  }
  lines.push("");
  lines.push(`Render timings: ${Object.entries(record.timings).map(([k, v]) => `${k} ${v.toFixed(0)} s`).join(", ")}.`);
  const text = `${lines.join("\n")}\n`;
  const path = join(r.dir, "report.md");
  writeFileSync(path, text);
  return path;
}
