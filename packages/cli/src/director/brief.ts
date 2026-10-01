/**
 * Adaptive director: versioned DIRECTOR_BRIEF (readable) + BriefConstraints (machine
 * rules with units/tolerances) generated from the request, preset, saved preferences,
 * media evidence and the current plan; refined only where QA/feedback implicates a rule.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BriefConstraintsSchema, flicksToSeconds, formatTimecode, readJson, writeJson, type BriefConstraints, type EditPlan, type Rule } from "../../../core/src/index.ts";
import type { CompiledGraphic } from "../../../core/src/luxury/graphics.ts";
import { loadPreset } from "../../../adapters/src/presets.ts";
import { P, nowIso, type Project } from "../project.ts";
import { loadPlan } from "../plans.ts";

export const briefDir = (p: Project, clipId: string) => join(P.brief(p), clipId);

export function briefVersions(p: Project, clipId: string): number[] {
  const dir = briefDir(p, clipId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^brief-v(\d{3})\.json$/.exec(f)?.[1])
    .filter((v): v is string => Boolean(v))
    .map(Number)
    .sort((a, b) => a - b);
}

export function loadBrief(p: Project, clipId: string, version?: number): BriefConstraints | null {
  const vs = briefVersions(p, clipId);
  const v = version ?? vs[vs.length - 1];
  if (!v) return null;
  return readJson(join(briefDir(p, clipId), `brief-v${String(v).padStart(3, "0")}.json`), BriefConstraintsSchema);
}

/** Explicit (non-tentative) bullet preferences from PREFERENCES.md. */
function preferenceRules(p: Project): Rule[] {
  const path = P.preferences(p);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => /^\s*-\s+/.test(l) && !/tentative/i.test(l))
    .map((l, i) => ({ id: `pref-${i + 1}`, area: "editorial" as const, rule: l.replace(/^\s*-\s+/, "").trim(), hard: false, source: "project" as const, sourceRef: "PREFERENCES.md" }));
}

function planRules(plan: EditPlan): Rule[] {
  const rules: Rule[] = [];
  const add = (r: Omit<Rule, "source">) => rules.push({ ...r, source: "brief" });
  add({ id: "plan-end", area: "timing", rule: `END ${flicksToSeconds(plan.output.durationFlicks).toFixed(3)} s = ${plan.output.frameCount} frames; last voice sample ${flicksToSeconds(plan.output.voiceEndFlicks).toFixed(3)} s; no frozen/silent tail`, param: plan.output.frameCount, unit: "frames", hard: true });
  for (const t of plan.takes) add({ id: `take-${t.lineId}`, area: "editorial", rule: `${t.lineId}: use ${t.chosenTakeId} — ${t.reason}`, hard: true });
  for (const r of plan.layoutRuns) {
    const g = plan.graphics.find((x) => x.id === r.graphicId);
    add({ id: `run-${r.id}`, area: "layout", rule: `${r.id} ${flicksToSeconds(r.outStart).toFixed(3)}–${flicksToSeconds(r.outEnd).toFixed(3)} s: ${r.layout}${g ? ` showing "${g.subject}"` : ""}; captions y ${r.captionZone.y0}–${r.captionZone.y1}${r.exceptions.length ? `; exceptions: ${r.exceptions.join("; ")}` : ""}`, param: { layout: r.layout, captionZone: r.captionZone }, hard: false });
  }
  for (const c of plan.cropPaths) add({ id: `crop-${c.id}`, area: "framing", rule: `${c.id}: ${c.keyframes.length === 1 && c.interpolation === "hold" ? "one held crop" : `${c.keyframes.length} keyframes (${c.interpolation})`} — ${c.reason}`, hard: plan.presetId === "luxury-tech" });
  if (plan.captions) {
    const hl = plan.captions.chunks.flatMap((c) => c.words.filter((w) => w.emphasis === "highlight").map((w) => w.text));
    add({ id: "captions-style", area: "captions", rule: `style ${plan.captions.styleId} v${plan.captions.styleVersion}; ${plan.captions.chunks.length} chunks; first caption ≥ ${(flicksToSeconds(plan.captions.minStartFlicks) * 1000).toFixed(1)} ms; highlighted: ${hl.join(", ") || "none"}`, hard: true });
  }
  for (const g of plan.graphics) {
    const c = (g.props as { compiled?: CompiledGraphic }).compiled;
    const moves = (c?.moves ?? []).map((m) => `${m.kind} ${m.t0.toFixed(2)}–${(m.t0 + m.dur).toFixed(2)} s → (${Math.round(m.to.x)}, ${Math.round(m.to.y)}) ×${m.to.s.toFixed(2)}`);
    add({ id: `graphic-${g.runId}`, area: "graphics", rule: `${g.runId} "${g.subject}": ${c?.items.length ?? 0} item(s); world camera ${moves.join("; ") || "glide only"}${g.sources.length ? `; sources: ${g.sources.map((s) => `${s.kind} ${s.url}${s.disclosed ? " (disclosed)" : ""}`).join(", ")}` : ""}`, hard: false });
  }
  const a = plan.audio;
  add({ id: "audio-voice", area: "audio", rule: `voice from ${a.voice.sourceId}; chain hp ${a.voice.chain.highpassHz ?? "off"} Hz, denoise ${a.voice.chain.denoise}, de-ess ${a.voice.chain.deess}, compress ${a.voice.chain.compress}; target ${a.voice.chain.targetLufs ?? "none"} LUFS`, param: a.voice.chain.targetLufs, unit: "LUFS", tolerance: 0.5, hard: false });
  if (a.music.mode !== "none") add({ id: "audio-music", area: "audio", rule: `${a.music.mode} music ${a.music.bpm} BPM key ${a.music.key} seed ${a.music.seed}; ${a.music.targetLufs} LUFS one flat gain; ducking ${a.music.ducking}; fade-out ${(flicksToSeconds(a.music.fadeOutFlicks) * 1000).toFixed(0)} ms ending at END`, param: a.music.targetLufs, unit: "LUFS", tolerance: 0.5, hard: false });
  if (a.sfx.length) add({ id: "audio-sfx", area: "audio", rule: `${a.sfx.length} SFX tied to visible events: ${[...new Set(a.sfx.map((s) => s.kind))].map((k) => `${a.sfx.filter((s) => s.kind === k).length}× ${k}`).join(", ")}`, hard: true });
  if (a.riser?.enabled) add({ id: "audio-riser", area: "audio", rule: `intro riser ${flicksToSeconds(a.riser.durationFlicks).toFixed(2)} s ending at ${flicksToSeconds(a.riser.endFlicks).toFixed(3)} s (hook → first point), ${a.riser.relPeakDb} dB re voice peak`, hard: false });
  add({ id: "audio-master", area: "audio", rule: `master ${a.master.targetLufs} LUFS integrated, ≤ ${a.master.maxTruePeakDbtp} dBTP true peak measured on the delivered AAC${a.master.aacHeadroomDb !== undefined ? `; pre-encode headroom ${a.master.aacHeadroomDb} dB` : ""}`, param: a.master.maxTruePeakDbtp, unit: "dBTP", hard: true });
  add({ id: "export-profile", area: "export", rule: `${plan.output.width}x${plan.output.height} @ ${plan.output.fps.num}/${plan.output.fps.den} fps, H.264 ${plan.output.video.profile} ${plan.output.video.pixFmt} crf ${plan.output.video.crf} preset ${plan.output.video.preset}, AAC ${plan.output.audio.bitrateKbps} kbps ${plan.output.sampleRate} Hz ${plan.output.audioChannels} ch`, hard: true });
  return rules;
}

const QA_CHECKS = ["export.spec", "export.decode", "audio.loudness", "audio.true-peak", "audio.stem-length", "captions.sync", "captions.safe-area", "captions.face-collision", "video.black-frozen", "timing.end"];
const LUXURY_QA = ["luxury.layouts", "luxury.static-footage", "luxury.landing-sharp", "luxury.caption-zones", "luxury.highlights", "luxury.sfx-rules", "luxury.matte", "luxury.ground", "luxury.cover-frame"];

export interface DraftOptions {
  goal?: string;
  audience?: string;
  instructions?: string[];
}

export function draftBrief(p: Project, clipId: string, opts: DraftOptions = {}): { brief: BriefConstraints; md: string; path: string } {
  const plan = loadPlan(p, clipId);
  const preset = loadPreset(plan.presetId);
  const words = plan.captions?.chunks.flatMap((c) => c.words) ?? [];
  const firstLine = plan.segments[0];
  const lastLine = plan.segments[plan.segments.length - 1];
  const lineText = (seg: typeof firstLine) => (seg ? words.filter((w) => seg.wordIds.includes(w.sourceWordId)).map((w) => w.text).join(" ") : "");
  const hook = lineText(firstLine) || words.slice(0, 12).map((w) => w.text).join(" ");
  const payoff = lineText(lastLine) || words.slice(-12).map((w) => w.text).join(" ");
  const userRules: Rule[] = [
    ...(opts.instructions ?? []).map((t, i) => ({ id: `user-${i + 1}`, area: "editorial" as const, rule: t, hard: true, source: "user" as const })),
    ...p.config.decisions
      .filter((d) => !d.clipId || d.clipId === clipId)
      .map((d, i) => ({ id: `decision-${i + 1}`, area: "editorial" as const, rule: `${d.key} = ${JSON.stringify(d.answer)}${d.note ? ` (${d.note})` : ""} [${d.source}]`, hard: d.source === "user", source: d.source === "user" ? ("user" as const) : ("default" as const) })),
  ];
  const evidence: BriefConstraints["evidence"] = [
    ...plan.decisions.map((d) => ({ claim: `${d.key}: ${typeof d.value === "string" ? d.value : JSON.stringify(d.value)} — ${d.reason}`, confidence: d.layer === "fallback" ? 0.5 : 0.85, ref: `plan v${plan.version}` })),
    ...plan.sources.filter((s) => s.clock).map((s) => ({ claim: `${s.sourceId} aligned to ${s.clock!.refSourceId}: ${s.clock!.method}, ${s.clock!.evidence}`, confidence: s.clock!.confidence, ref: "sync.json" })),
    ...plan.takes.map((t) => ({ claim: `${t.lineId} take choice: ${t.reason}`, confidence: t.swappedFromLast ? 0.75 : 0.9, ref: "creator-report.md" })),
  ];
  const prev = loadBrief(p, clipId);
  const version = `brief-v${String((briefVersions(p, clipId).at(-1) ?? 0) + 1).padStart(3, "0")}`;
  const brief = BriefConstraintsSchema.parse({
    schemaVersion: 1,
    version,
    projectId: p.config.id,
    clipId,
    createdAt: nowIso(),
    presetId: preset.id,
    intent: {
      goal: opts.goal ?? (plan.createdBy === "creator-edit" || plan.takes.length ? "a finished short from the creator's final takes, clean mic voice, in sync" : `a standalone short from ${plan.candidateId ?? "the selected range"}`),
      audience: opts.audience ?? `${p.config.platforms.join(", ")} viewers watching muted-first on a phone`,
      hook,
      payoff,
      platforms: p.config.platforms,
    },
    evidence,
    rules: [...userRules, ...preset.rules.map((r) => ({ ...r, source: "preset" as const })), ...preferenceRules(p), ...planRules(plan)],
    conflicts: [],
    qaChecks: [...QA_CHECKS, ...(plan.presetId === "luxury-tech" ? LUXURY_QA : [])],
    fallbacks: plan.fallbacks.map((f) => ({ capability: f.capability, fallback: f.fallback, reason: f.reason })),
    stopCriteria: { maxRepairPasses: p.config.repair.maxPasses, maxMinutes: p.config.repair.maxMinutes, requireNoHardFailures: true },
    changelog: [...(prev?.changelog ?? []), { fromVersion: prev?.version ?? null, toVersion: version, at: nowIso(), ruleIds: [], change: prev ? `re-drafted from plan v${plan.version}` : `initial brief from plan v${plan.version}`, trigger: prev ? "preference" : "initial", evidence: `plan v${plan.version}, preset ${preset.id} ${preset.version}` }],
  });
  return { brief, md: renderBrief(brief, plan), path: saveBrief(p, clipId, brief, plan) };
}

function saveBrief(p: Project, clipId: string, brief: BriefConstraints, plan: EditPlan): string {
  const dir = briefDir(p, clipId);
  mkdirSync(dir, { recursive: true });
  const json = join(dir, `${brief.version}.json`);
  if (existsSync(json)) throw new Error(`${brief.version} already exists; briefs are never overwritten`);
  writeJson(json, brief);
  const md = join(dir, `${brief.version}.md`);
  writeFileSync(md, renderBrief(brief, plan));
  copyFileSync(md, join(dir, "DIRECTOR_BRIEF.md"));
  return md;
}

/** Applies rule changes implicated by evidence and saves the next brief version. */
export function refineBrief(p: Project, clipId: string, change: { trigger: "user-feedback" | "qa-finding" | "preference"; evidence: string; summary: string; upsert?: Rule[]; remove?: string[] }): { brief: BriefConstraints; path: string } {
  const prev = loadBrief(p, clipId) ?? draftBrief(p, clipId).brief;
  const plan = loadPlan(p, clipId);
  const version = `brief-v${String(Number(prev.version.slice(7)) + 1).padStart(3, "0")}`;
  const upserts = change.upsert ?? [];
  const removed = new Set(change.remove ?? []);
  const rules = [...prev.rules.filter((r) => !removed.has(r.id) && !upserts.some((u) => u.id === r.id)), ...upserts];
  // Plan-derived rules always reflect the current plan version.
  const refreshed = [...rules.filter((r) => r.source !== "brief"), ...planRules(plan)];
  const brief = BriefConstraintsSchema.parse({
    ...prev,
    version,
    createdAt: nowIso(),
    rules: refreshed,
    fallbacks: plan.fallbacks.map((f) => ({ capability: f.capability, fallback: f.fallback, reason: f.reason })),
    changelog: [...prev.changelog, { fromVersion: prev.version, toVersion: version, at: nowIso(), ruleIds: [...upserts.map((u) => u.id), ...removed], change: change.summary, trigger: change.trigger, evidence: change.evidence }],
  });
  return { brief, path: saveBrief(p, clipId, brief, plan) };
}

export function renderBrief(b: BriefConstraints, plan: EditPlan): string {
  const by = (area: Rule["area"]) => b.rules.filter((r) => r.area === area);
  const fmt = (r: Rule) => `- **${r.id}** (${r.source}${r.hard ? ", hard" : ""}): ${r.rule}${r.unit ? ` [${JSON.stringify(r.param)} ${r.unit}${r.tolerance !== undefined ? ` ±${JSON.stringify(r.tolerance)}` : ""}]` : ""}`;
  const runs = plan.layoutRuns.map((r) => `| ${r.id} | ${flicksToSeconds(r.outStart).toFixed(3)}–${flicksToSeconds(r.outEnd).toFixed(3)} | ${r.layout} | ${plan.graphics.find((g) => g.id === r.graphicId)?.subject ?? "—"} | ${r.captionZone.y0}–${r.captionZone.y1} | ${r.reason.replace(/\|/g, "/")} |`);
  return [
    `# DIRECTOR_BRIEF — ${b.projectId}/${b.clipId} ${b.version}`,
    "",
    `Preset **${b.presetId}** · plan v${plan.version} · created ${b.createdAt}. Precedence: current explicit user instructions → preset + saved project overrides → this brief → renderer defaults.`,
    "",
    "## 1. Editorial intent",
    `- Goal: ${b.intent.goal}`,
    `- Audience: ${b.intent.audience}`,
    `- Hook preserved: “${b.intent.hook}”`,
    `- Payoff preserved: “${b.intent.payoff}”`,
    ...by("editorial").filter((r) => r.source === "user" || r.source === "project").map(fmt),
    "",
    "## 2. Input evidence (with confidence)",
    ...b.evidence.map((e) => `- ${e.claim} — confidence ${e.confidence.toFixed(2)}${e.ref ? ` (${e.ref})` : ""}`),
    "",
    "## 3. Timing, takes and cut rules",
    ...by("timing").map(fmt),
    ...by("editorial").filter((r) => r.id.startsWith("take-")).map(fmt),
    ...plan.segments.map((s) => `- ${s.id}${s.lineId ? ` (${s.lineId}${s.takeId ? `/${s.takeId}` : ""})` : ""}: source ${formatTimecode(s.picture.srcStart)} → output ${flicksToSeconds(s.picture.outStart).toFixed(3)}–${flicksToSeconds(s.picture.outEnd).toFixed(3)} s${s.note ? ` — ${s.note}` : ""}`),
    "",
    "## 4. Layout runs, crops and allowed motion",
    "| Run | Time (s) | Layout | Graphic | Caption zone | Why |",
    "| --- | --- | --- | --- | --- | --- |",
    ...runs,
    "",
    ...by("layout").filter((r) => !r.id.startsWith("run-")).map(fmt),
    ...by("framing").map(fmt),
    "",
    "## 5. Captions",
    ...by("captions").map(fmt),
    "",
    "## 6. Graphics",
    ...by("graphics").map(fmt),
    "",
    "## 7. Audio",
    ...by("audio").map(fmt),
    "",
    "## 8. Export, QA, fallbacks and stop criteria",
    ...by("export").map(fmt),
    `- QA checks: ${b.qaChecks.join(", ")}`,
    ...b.fallbacks.map((f) => `- Fallback — ${f.capability}: ${f.fallback} (${f.reason})`),
    `- Stop: at most ${b.stopCriteria.maxRepairPasses} automatic repair pass(es) or ${b.stopCriteria.maxMinutes} min; ${b.stopCriteria.requireNoHardFailures ? "no hard QA failure may remain — otherwise the output is a blocked/draft deliverable" : "hard failures are reported"}.`,
    "",
    "## 9. Conflicts",
    ...(b.conflicts.length ? b.conflicts.map((c) => `- ${c.ruleIds.join(" vs ")}: ${c.resolution}${c.askedUser ? " (asked the user)" : ""}`) : ["- none detected"]),
    "",
    "## 10. Change log",
    ...b.changelog.map((c) => `- ${c.fromVersion ?? "∅"} → ${c.toVersion} (${c.trigger}): ${c.change}${c.ruleIds.length ? ` [rules: ${c.ruleIds.join(", ")}]` : ""} — evidence: ${c.evidence}`),
    "",
  ].join("\n");
}
