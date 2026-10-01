import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CaptionStyleSchema, PresetSchema, type CaptionStyle, type Preset } from "../../core/src/index.ts";
import { paths } from "./env.ts";

export interface PlatformGuides {
  canvas: { width: number; height: number };
  guides: Record<string, { top: number; bottom: number; left: number; right: number }>;
  limits: Record<string, { maxDurationSec: number; verifiedAt: string | null; note: string }>;
}

function resolveRefs(value: unknown, root: string): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, root));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$ref === "string" && Object.keys(obj).length === 1) {
      return JSON.parse(readFileSync(join(root, obj.$ref), "utf8"));
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveRefs(v, root)]));
  }
  return value;
}

/** Workspace overrides live in <workspace>/.shorts-studio/presets and win over plugin copies. */
function presetDirs(kind: "editorial" | "captions"): string[] {
  const p = paths();
  return [join(p.workspace, ".shorts-studio", "presets", kind), join(p.presetsDir, kind)];
}

function findFile(kind: "editorial" | "captions", id: string): string {
  for (const dir of presetDirs(kind)) {
    const f = join(dir, `${id}.json`);
    if (existsSync(f)) return f;
  }
  throw new Error(`unknown ${kind === "editorial" ? "preset" : "caption style"} "${id}". Available: ${listIds(kind).join(", ")}`);
}

export function listIds(kind: "editorial" | "captions"): string[] {
  const ids = new Set<string>();
  for (const dir of presetDirs(kind)) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".json")) ids.add(f.slice(0, -5));
  }
  return [...ids].sort();
}

export function loadPreset(id: string): Preset {
  const file = findFile("editorial", id);
  const raw = resolveRefs(JSON.parse(readFileSync(file, "utf8")), paths().pluginRoot);
  const parsed = PresetSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`preset ${id} (${file}) is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export function loadCaptionStyle(id: string): CaptionStyle {
  const file = findFile("captions", id);
  const parsed = CaptionStyleSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`caption style ${id} (${file}) is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export function loadPlatforms(): PlatformGuides {
  return JSON.parse(readFileSync(join(paths().presetsDir, "platforms.json"), "utf8")) as PlatformGuides;
}

export function loadLuxuryTokens(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(paths().presetsDir, "luxury-tech", "tokens.json"), "utf8")) as Record<string, unknown>;
}
