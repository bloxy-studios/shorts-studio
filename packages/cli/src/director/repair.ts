/**
 * Bounded critique → refine → verify loop. QA findings with a safe, targeted fix
 * become plan changes (new plan version, brief refinement with evidence), then the
 * clip is re-rendered from caches and re-checked. Stops on a clean pass, when no
 * fixable finding remains, or when the pass/time budget is spent.
 */
import { join } from "node:path";
import {
  EditPlanSchema,
  TimeMap,
  flicksToSeconds,
  isFunctionWord,
  type EditPlan,
  type QAFinding,
  type QAReport,
  type Rule,
  type VisualAnalysis,
} from "../../../core/src/index.ts";
import { loadCaptionStyle } from "../../../adapters/src/presets.ts";
import { P, nowIso, type Project } from "../project.ts";
import { loadPlan, nextPlanVersion, saveRender, savePlan } from "../plans.ts";
import { loadVisual } from "../commands/analyze.ts";
import { pieces } from "../render/video.ts";
import { info, stage, warn } from "../ui.ts";
import { refineBrief } from "./brief.ts";

export interface RepairAction {
  findingId: string;
  check: string;
  description: string;
  rule: Rule;
  apply(plan: EditPlan): EditPlan;
}

const CAPTION_ZONES: Array<{ y0: number; y1: number }> = [
  { y0: 1267, y1: 1536 },
  { y0: 1037, y1: 1306 },
  { y0: 365, y1: 634 },
  { y0: 941, y1: 1114 },
];

/** Canvas face boxes presented during a run (5 fps samples through the run's crop). */
function runFaces(plan: EditPlan, runId: string, visual: VisualAnalysis | null): Array<{ y0: number; y1: number }> {
  if (!visual) return [];
  const out: Array<{ y0: number; y1: number }> = [];
  const map = new TimeMap(plan.timeMap);
  for (const pc of pieces(plan).filter((x) => x.runId === runId)) {
    const crop = plan.cropPaths.find((c) => c.id === pc.cropPathId);
    const slot = pc.slots.find((s) => s.cropPathId === crop?.id);
    if (!crop || !slot) continue;
    const box = crop.keyframes[0]!.box;
    for (const tr of visual.faceTracks)
      for (const s of tr.samples) {
        if (!map.srcToOut("video", pc.sourceId, s.t).some((o) => o >= pc.outStart && o < pc.outEnd)) continue;
        const sy = slot.region.h / box.h;
        out.push({ y0: slot.region.y + (s.box.y - box.y) * sy, y1: slot.region.y + (s.box.y + s.box.h - box.y) * sy });
      }
  }
  return out;
}

export function planRepairs(plan: EditPlan, qa: QAReport, visual: VisualAnalysis | null): { actions: RepairAction[]; unfixable: QAFinding[] } {
  const actions: RepairAction[] = [];
  const unfixable: QAFinding[] = [];
  const open = qa.findings.filter((f) => f.status === "fail" || f.status === "warn");
  for (const f of open) {
    const rule = (id: string, area: Rule["area"], text: string, hard = true): Rule => ({ id, area, rule: text, hard, source: "qa-refinement", sourceRef: `${qa.renderId}/${f.id} ${f.check}` });
    switch (f.check) {
      case "audio.true-peak": {
        const next = Math.min(2, (plan.audio.master.aacHeadroomDb ?? 0.6) + 0.4);
        actions.push({ findingId: f.id, check: f.check, description: `raise pre-encode headroom to ${next.toFixed(1)} dB (AAC overshoot measured: ${f.message})`, rule: rule("audio-aac-headroom", "audio", `pre-encode true-peak headroom ${next.toFixed(1)} dB below the ${plan.audio.master.maxTruePeakDbtp} dBTP ceiling`), apply: (p) => ({ ...p, audio: { ...p.audio, master: { ...p.audio.master, aacHeadroomDb: next } } }) });
        break;
      }
      case "luxury.sfx-rules": {
        const violations = ((f.evidence.measurements.violations as Array<{ id: string; rule: string; detail: string }>) ?? []).filter((v) => v.rule !== "whoosh-max-per-run");
        const ids = new Set(violations.flatMap((v) => v.id.split(",")));
        const remove = plan.audio.sfx.filter((s) => ids.has(s.id));
        if (!remove.length) {
          unfixable.push(f);
          break;
        }
        actions.push({ findingId: f.id, check: f.check, description: `remove ${remove.length} sound event(s) that break the SFX vocabulary (${violations.map((v) => v.rule).join(", ")}) — the preset rule stays`, rule: rule("audio-sfx-removed", "audio", `removed ${remove.map((s) => `${s.kind}@${flicksToSeconds(s.t).toFixed(2)}`).join(", ")}: ${violations.map((v) => v.detail).join("; ")}`), apply: (p) => ({ ...p, audio: { ...p.audio, sfx: p.audio.sfx.filter((s) => !ids.has(s.id)) } }) });
        break;
      }
      case "captions.face-collision": {
        const chunkIds = new Set(f.affects.chunkIds);
        const runIds = [...new Set(plan.layoutRuns.filter((r) => plan.captions?.chunks.some((c) => chunkIds.has(c.id) && c.outStart >= r.outStart && c.outStart < r.outEnd)).map((r) => r.id))];
        for (const runId of runIds) {
          const faces = runFaces(plan, runId, visual);
          const run = plan.layoutRuns.find((r) => r.id === runId)!;
          const clear = CAPTION_ZONES.find((z) => (z.y0 !== run.captionZone.y0 || z.y1 !== run.captionZone.y1) && faces.every((fb) => fb.y1 < z.y0 - 10 || fb.y0 > z.y1 + 10));
          if (!clear) {
            unfixable.push(f);
            continue;
          }
          actions.push({ findingId: f.id, check: f.check, description: `${runId}: move captions from y ${run.captionZone.y0}–${run.captionZone.y1} to ${clear.y0}–${clear.y1} (clear of the face) — other runs untouched`, rule: rule(`run-${runId}-caption-zone`, "captions", `${runId} captions at y ${clear.y0}–${clear.y1} (face measured at y ${Math.round(Math.min(...faces.map((x) => x.y0)))}–${Math.round(Math.max(...faces.map((x) => x.y1)))})`), apply: (p) => ({ ...p, layoutRuns: p.layoutRuns.map((r) => (r.id === runId ? { ...r, captionZone: clear, exceptions: [...r.exceptions, `caption zone moved by repair (${f.check})`] } : r)) }) });
        }
        break;
      }
      case "luxury.highlights": {
        if (!plan.captions) break;
        const style = loadCaptionStyle(plan.captions.styleId);
        actions.push({
          findingId: f.id,
          check: f.check,
          description: "clear highlights on function words and on the second of any consecutive highlighted chunks",
          rule: rule("captions-highlight-repair", "captions", "highlights only on meaningful words, never in consecutive chunks"),
          apply: (p) => {
            let prevHl = false;
            const chunks = p.captions!.chunks.map((c) => {
              let words = c.words.map((w) => (w.emphasis === "highlight" && isFunctionWord(w.text) ? { ...w, emphasis: "none" as const } : w));
              const has = words.some((w) => w.emphasis === "highlight");
              if (has && prevHl) words = words.map((w) => (w.emphasis === "highlight" ? { ...w, emphasis: "none" as const } : w));
              prevHl = words.some((w) => w.emphasis === "highlight");
              return { ...c, words };
            });
            void style;
            return { ...p, captions: { ...p.captions!, chunks } };
          },
        });
        break;
      }
      case "luxury.static-footage": {
        actions.push({ findingId: f.id, check: f.check, description: "hold every Luxury camera crop at its first keyframe", rule: rule("framing-static", "framing", "camera footage crops are held (no pan/zoom/punch-in)"), apply: (p) => ({ ...p, cropPaths: p.cropPaths.map((c) => ({ ...c, keyframes: [{ ...c.keyframes[0]!, t: 0, hold: true }], interpolation: "hold" as const })) }) });
        break;
      }
      default:
        if (f.severity !== "info") unfixable.push(f);
    }
  }
  return { actions, unfixable };
}

export interface RepairPass {
  pass: number;
  planVersion: number;
  renderId: string;
  verdict: string;
  actions: string[];
  briefVersion: string | null;
}

export async function repairLoop(p: Project, clipId: string, start: { qa: QAReport }, opts: { maxPasses?: number; maxMinutes?: number } = {}): Promise<{ passes: RepairPass[]; finalVerdict: string; unresolved: string[]; stoppedBecause: string }> {
  const maxPasses = opts.maxPasses ?? p.config.repair.maxPasses;
  const deadline = performance.now() + (opts.maxMinutes ?? p.config.repair.maxMinutes) * 60_000;
  const { renderClip } = await import("../render/pipeline.ts");
  const { runQA } = await import("../qa/checks.ts");
  const { writeReport } = await import("../report.ts");
  const passes: RepairPass[] = [];
  let qa = start.qa;
  let stoppedBecause = "clean pass";
  for (let pass = 1; ; pass++) {
    const plan = loadPlan(p, clipId);
    const visual = loadVisual(p, plan.segments[0]!.picture.sourceId);
    const { actions, unfixable } = planRepairs(plan, qa, visual);
    const hard = qa.findings.filter((f) => f.severity === "hard" && f.status === "fail");
    if (!actions.length) {
      stoppedBecause = hard.length ? "no safe automatic fix for the remaining hard failure(s)" : unfixable.length ? "only findings without a safe automatic fix remain" : "clean pass";
      break;
    }
    if (pass > maxPasses) {
      stoppedBecause = `repair budget spent (${maxPasses} pass(es))`;
      break;
    }
    if (performance.now() > deadline) {
      stoppedBecause = "repair time budget spent";
      break;
    }
    stage("repair", `pass ${pass}/${maxPasses}: ${actions.length} targeted fix(es)`);
    let next = plan;
    for (const a of actions) {
      info(`  • ${a.check}: ${a.description}`);
      next = a.apply(next);
    }
    const version = nextPlanVersion(p, clipId);
    next = EditPlanSchema.parse({ ...next, version, parentVersion: plan.version, createdAt: nowIso(), createdBy: "repair", changeSummary: `repair pass ${pass}: ${actions.map((a) => a.check).join(", ")}`, changes: actions.map((a) => ({ path: a.check, op: "repair", reason: a.description, evidence: `${qa.renderId}/${a.findingId}` })) });
    savePlan(p, next);
    const refined = refineBrief(p, clipId, { trigger: "qa-finding", evidence: actions.map((a) => `${qa.renderId}/${a.findingId} ${a.check}`).join("; "), summary: `repair pass ${pass}: ${actions.map((a) => a.description).join("; ")}`, upsert: actions.map((a) => a.rule) });
    const out = await renderClip(p, clipId, {});
    qa = await runQA({ p, plan: out.plan, record: out.record, captions: out.captions, sources: out.sources, dir: out.dir, luxury: out.luxury });
    const rec = { ...out.record, qaVerdict: qa.summary.verdict, paths: { ...out.record.paths, qa: join(out.dir, "qa.json") } as Record<string, string> };
    rec.paths.report = writeReport({ plan: out.plan, record: rec, qa, sources: out.sources, transcript: null, coverage: null, captions: out.captions, dir: out.dir });
    saveRender(p, rec);
    passes.push({ pass, planVersion: version, renderId: out.record.id, verdict: qa.summary.verdict, actions: actions.map((a) => `${a.check}: ${a.description}`), briefVersion: refined.brief.version });
    info(`  → ${out.record.id}: ${qa.summary.verdict} (${qa.summary.hardFailures} hard, ${qa.summary.warnings} warnings)`);
  }
  const unresolved = qa.findings.filter((f) => f.status === "fail" || (f.status === "warn" && f.severity !== "info")).map((f) => `${f.check} (${f.severity} ${f.status}): ${f.message}`);
  if (qa.summary.hardFailures) warn(`hard failure(s) remain — the deliverable is ${qa.summary.verdict}, not a pass`);
  void P;
  return { passes, finalVerdict: qa.summary.verdict, unresolved, stoppedBecause };
}
