import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  ProjectConfigSchema,
  readJson,
  writeJson,
  type ClipEntry,
  type Decision,
  type ProjectConfig,
} from "../../core/src/index.ts";
import { paths } from "../../adapters/src/env.ts";

export interface Project {
  dir: string;
  config: ProjectConfig;
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "project";
}

export function nowIso(): string {
  return new Date().toISOString();
}

export const P = {
  config: (p: Project) => join(p.dir, "project.json"),
  preferences: (p: Project) => join(p.dir, "PREFERENCES.md"),
  sources: (p: Project) => join(p.dir, "sources"),
  source: (p: Project, id: string) => join(p.dir, "sources", id),
  analysis: (p: Project, id: string) => join(p.dir, "analysis", id),
  candidates: (p: Project) => join(p.dir, "analysis", "candidates.json"),
  brief: (p: Project) => join(p.dir, "brief"),
  clip: (p: Project, clipId: string) => join(p.dir, "clips", clipId),
  plans: (p: Project, clipId: string) => join(p.dir, "clips", clipId, "plans"),
  renders: (p: Project, clipId: string) => join(p.dir, "clips", clipId, "renders"),
  render: (p: Project, clipId: string, renderId: string) => join(p.dir, "clips", clipId, "renders", renderId),
  review: (p: Project) => join(p.dir, "review"),
  state: (p: Project) => join(p.dir, "state"),
  exports: (p: Project) => join(p.dir, "exports"),
  edit: (p: Project) => join(p.dir, "edit"),
};

/** Accepts a project directory path, a project id, or a name. */
export function resolveProjectDir(ref: string): string {
  const asPath = isAbsolute(ref) ? ref : resolve(ref);
  if (existsSync(join(asPath, "project.json"))) return asPath;
  const byId = join(paths().projectsDir, slugify(ref));
  if (existsSync(join(byId, "project.json"))) return byId;
  const direct = join(paths().projectsDir, ref);
  if (existsSync(join(direct, "project.json"))) return direct;
  throw new Error(`no project "${ref}" (looked in ${asPath} and ${paths().projectsDir}). Create one with: ss project init <name>`);
}

export function loadProject(ref: string): Project {
  const dir = resolveProjectDir(ref);
  return { dir, config: readJson(join(dir, "project.json"), ProjectConfigSchema) };
}

export function saveProject(p: Project): void {
  p.config = ProjectConfigSchema.parse({ ...p.config, updatedAt: nowIso() });
  writeJson(P.config(p), p.config);
}

export function listProjects(): string[] {
  const dir = paths().projectsDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => existsSync(join(dir, d, "project.json")));
}

export interface InitOptions {
  preset?: string;
  mode?: ProjectConfig["mode"];
  platforms?: ProjectConfig["platforms"];
  clipCount?: number;
  durationBand?: { minSec: number; maxSec: number };
  language?: string;
  dir?: string;
}

export function initProject(name: string, opts: InitOptions = {}): Project {
  const id = slugify(name);
  const dir = opts.dir ? resolve(opts.dir) : join(paths().projectsDir, id);
  if (existsSync(join(dir, "project.json"))) return loadProject(dir);
  mkdirSync(dir, { recursive: true });
  for (const sub of ["sources", "analysis", "brief", "clips", "review", "state", "exports"]) mkdirSync(join(dir, sub), { recursive: true });
  const now = nowIso();
  const config = ProjectConfigSchema.parse({
    schemaVersion: 1,
    id: basename(dir),
    name,
    createdAt: now,
    updatedAt: now,
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.preset ? { presetId: opts.preset } : {}),
    ...(opts.platforms ? { platforms: opts.platforms } : {}),
    ...(opts.clipCount ? { clipCount: opts.clipCount } : {}),
    ...(opts.durationBand ? { durationBand: opts.durationBand } : {}),
    ...(opts.language ? { language: opts.language } : {}),
  });
  const project: Project = { dir, config };
  writeJson(P.config(project), config);
  writeFileSync(
    P.preferences(project),
    `# Project preferences — ${name}\n\nExplicit preferences for this project only. Workspace-wide defaults live in \`.shorts-studio/PREFERENCES.md\`.\nTentative inferences are marked *(tentative)* and are never promoted to defaults without an explicit "save this as my default".\n\n`,
  );
  return project;
}

export function recordDecision(p: Project, d: Omit<Decision, "at" | "scope" | "persisted"> & Partial<Pick<Decision, "scope" | "persisted">>): void {
  const decision: Decision = { scope: "project", persisted: false, ...d, at: nowIso() };
  p.config.decisions = [...p.config.decisions.filter((x) => !(x.key === d.key && x.clipId === d.clipId)), decision];
  saveProject(p);
}

export function findDecision(p: Project, key: string, clipId?: string): Decision | undefined {
  return p.config.decisions.find((d) => d.key === key && (clipId === undefined || d.clipId === clipId || d.clipId === undefined));
}

export function upsertClip(p: Project, clip: Partial<ClipEntry> & { id: string }): ClipEntry {
  const existing = p.config.clips.find((c) => c.id === clip.id);
  const merged = { kind: "clip", currentPlanVersion: 0, approvedRenderId: null, latestRenderId: null, ...existing, ...clip } as ClipEntry;
  p.config.clips = [...p.config.clips.filter((c) => c.id !== clip.id), merged].sort((a, b) => a.id.localeCompare(b.id));
  saveProject(p);
  return merged;
}

export function nextClipId(p: Project): string {
  const n = p.config.clips.length + 1;
  return `clip-${String(n).padStart(2, "0")}`;
}
