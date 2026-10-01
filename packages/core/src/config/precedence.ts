/**
 * Rule precedence (highest first):
 *   current explicit user instructions → saved project overrides → chosen preset
 *   → generated directing brief → renderer/skill defaults.
 * Leaves are merged path-by-path with provenance so every effective setting can
 * be explained, and overridden hard rules surface as conflicts before rendering.
 */

export const LAYERS = ["user", "project", "preset", "brief", "default"] as const;
export type Layer = (typeof LAYERS)[number];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Provenance {
  path: string;
  value: Json;
  layer: Layer;
  overridden: Array<{ layer: Layer; value: Json }>;
}

export interface Conflict {
  path: string;
  winner: { layer: Layer; value: Json };
  loser: { layer: Layer; value: Json };
  hard: boolean;
  message: string;
}

export interface LayerInput {
  values: { [key: string]: Json };
  /** Paths (dot notation) that this layer declares as hard rules. */
  hardPaths?: string[];
}

function isPlainObject(v: unknown): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function flatten(obj: { [key: string]: Json }, prefix = "", out = new Map<string, Json>()): Map<string, Json> {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && Object.keys(v).length > 0) flatten(v, path, out);
    else out.set(path, v);
  }
  return out;
}

function setPath(target: { [key: string]: Json }, path: string, value: Json): void {
  const parts = path.split(".");
  let node: { [key: string]: Json } = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!isPlainObject(next)) node[part] = {};
    node = node[part] as { [key: string]: Json };
  }
  node[parts[parts.length - 1]!] = value;
}

export function resolveLayers(layers: Partial<Record<Layer, LayerInput>>): {
  merged: { [key: string]: Json };
  provenance: Map<string, Provenance>;
  conflicts: Conflict[];
} {
  const provenance = new Map<string, Provenance>();
  const conflicts: Conflict[] = [];
  // Walk lowest precedence first so higher layers overwrite.
  for (const layer of [...LAYERS].reverse()) {
    const input = layers[layer];
    if (!input) continue;
    for (const [path, value] of flatten(input.values)) {
      const prev = provenance.get(path);
      if (prev && JSON.stringify(prev.value) !== JSON.stringify(value)) {
        const lowerHard = layers[prev.layer]?.hardPaths?.some((h) => path === h || path.startsWith(`${h}.`)) ?? false;
        conflicts.push({
          path,
          winner: { layer, value },
          loser: { layer: prev.layer, value: prev.value },
          hard: lowerHard,
          message: lowerHard
            ? `${layer} setting for "${path}" overrides a hard ${prev.layer} rule`
            : `${layer} setting for "${path}" replaces the ${prev.layer} value`,
        });
      }
      provenance.set(path, {
        path,
        value,
        layer,
        overridden: prev ? [...prev.overridden, { layer: prev.layer, value: prev.value }] : [],
      });
    }
  }
  const merged: { [key: string]: Json } = {};
  for (const p of provenance.values()) setPath(merged, p.path, p.value);
  return { merged, provenance, conflicts };
}

/** Conflicts that change the creative result materially (hard rules overridden). */
export function materialConflicts(conflicts: readonly Conflict[]): Conflict[] {
  return conflicts.filter((c) => c.hard);
}
