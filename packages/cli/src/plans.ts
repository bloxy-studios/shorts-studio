import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EditPlanSchema,
  RenderRecordSchema,
  listVersions,
  readJson,
  readJsonIfExists,
  versionedPath,
  writeJson,
  type EditPlan,
  type RenderRecord,
} from "../../core/src/index.ts";
import { P, upsertClip, type Project } from "./project.ts";

/** Plans are immutable versions; `current.json` points at the active one. */
export function savePlan(p: Project, plan: EditPlan): string {
  const dir = P.plans(p, plan.clipId);
  const file = versionedPath(dir, "editplan", plan.version);
  if (existsSync(file)) throw new Error(`plan ${plan.clipId} v${plan.version} already exists; plans are never overwritten`);
  writeJson(file, EditPlanSchema.parse(plan));
  writeJson(join(dir, "current.json"), { version: plan.version, file });
  upsertClip(p, { id: plan.clipId, currentPlanVersion: plan.version, ...(plan.candidateId ? { candidateId: plan.candidateId } : {}) });
  return file;
}

export function currentPlanVersion(p: Project, clipId: string): number {
  const ptr = join(P.plans(p, clipId), "current.json");
  if (existsSync(ptr)) {
    const v = (JSON.parse(readFileSync(ptr, "utf8")) as { version?: number }).version;
    if (v) return v;
  }
  const versions = listVersions(P.plans(p, clipId), "editplan");
  if (versions.length === 0) throw new Error(`clip ${clipId} has no plan yet; run: shorts-studio plan ${p.config.id} ...`);
  return versions[versions.length - 1]!;
}

export function loadPlan(p: Project, clipId: string, version?: number): EditPlan {
  const v = version ?? currentPlanVersion(p, clipId);
  return readJson(versionedPath(P.plans(p, clipId), "editplan", v), EditPlanSchema);
}

export function nextPlanVersion(p: Project, clipId: string): number {
  const versions = listVersions(P.plans(p, clipId), "editplan");
  return (versions[versions.length - 1] ?? 0) + 1;
}

export function nextRenderId(p: Project, clipId: string): string {
  const dir = P.renders(p, clipId);
  const n = existsSync(dir) ? readdirSync(dir).filter((d) => /^r\d{3}$/.test(d)).length : 0;
  return `r${String(n + 1).padStart(3, "0")}`;
}

export function saveRender(p: Project, rec: RenderRecord): void {
  writeJson(join(P.render(p, rec.clipId, rec.id), "render.json"), RenderRecordSchema.parse(rec));
}

export function loadRender(p: Project, clipId: string, renderId: string): RenderRecord | null {
  return readJsonIfExists(join(P.render(p, clipId, renderId), "render.json"), RenderRecordSchema);
}
