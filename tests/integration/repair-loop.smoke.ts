/**
 * End-to-end director repair loop on a real project: inject a forbidden whoosh (no whip,
 * on a layout cut) as a new plan version, render + QA (expect a hard luxury.sfx-rules
 * failure), then run the bounded repair loop and verify the fix, the brief changelog and
 * the clean re-check.
 *   SS_DEV=1 bun tests/integration/repair-loop.smoke.ts <project> <clip>
 */
import { join } from "node:path";
import { EditPlanSchema } from "../../packages/core/src/index.ts";
import { loadProject, nowIso } from "../../packages/cli/src/project.ts";
import { loadPlan, nextPlanVersion, savePlan, saveRender } from "../../packages/cli/src/plans.ts";
import { renderClip } from "../../packages/cli/src/render/pipeline.ts";
import { runQA } from "../../packages/cli/src/qa/checks.ts";
import { draftBrief, loadBrief } from "../../packages/cli/src/director/brief.ts";
import { repairLoop } from "../../packages/cli/src/director/repair.ts";

const [projectRef = "creator-luxury", clipId = "creator-edit"] = process.argv.slice(2);
const p = loadProject(projectRef);
if (!loadBrief(p, clipId)) draftBrief(p, clipId);
const base = loadPlan(p, clipId);
const cut = base.layoutRuns[1]!.outStart;
const bad = EditPlanSchema.parse({
  ...base,
  version: nextPlanVersion(p, clipId),
  parentVersion: base.version,
  createdAt: nowIso(),
  createdBy: "director",
  changeSummary: "TEST: injected an unlinked whoosh on a layout cut (forbidden by lt-whoosh-whip)",
  changes: [{ path: "audio.sfx", op: "add", reason: "repair-loop smoke test" }],
  audio: { ...base.audio, sfx: [...base.audio.sfx, { id: "sfx-bad", t: cut, kind: "whoosh", variant: 2, relPeakDb: -9, reason: "injected: whoosh on a layout cut" }] },
});
savePlan(p, bad);
const out = await renderClip(p, clipId, {});
const qa = await runQA({ p, plan: out.plan, record: out.record, captions: out.captions, sources: out.sources, dir: out.dir, luxury: out.luxury });
saveRender(p, { ...out.record, qaVerdict: qa.summary.verdict, paths: { ...out.record.paths, qa: join(out.dir, "qa.json") } });
const sfx = qa.findings.find((f) => f.check === "luxury.sfx-rules")!;
console.log(`injected render ${out.record.id}: ${qa.summary.verdict}; luxury.sfx-rules ${sfx.status}: ${sfx.message}`);
if (sfx.status !== "fail") throw new Error("expected the injected whoosh to fail luxury.sfx-rules");

const res = await repairLoop(p, clipId, { qa }, { maxPasses: 2 });
console.log(JSON.stringify({ passes: res.passes, final: res.finalVerdict, stopped: res.stoppedBecause, unresolved: res.unresolved }, null, 2));
const fixed = loadPlan(p, clipId);
if (fixed.audio.sfx.some((s) => s.id === "sfx-bad")) throw new Error("repair did not remove the injected whoosh");
const brief = loadBrief(p, clipId)!;
const entry = brief.changelog.find((c) => c.trigger === "qa-finding");
if (!entry) throw new Error("brief changelog has no qa-finding entry");
if (res.finalVerdict === "blocked" || res.finalVerdict === "draft") throw new Error(`still ${res.finalVerdict} after repair`);
console.log(`OK: ${brief.version} — ${entry.change} (evidence: ${entry.evidence})`);
