import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { z } from "zod";

/** Atomic write: temp file in the same directory, fsync, rename. */
export function writeFileAtomic(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.floor(performance.now() * 1000)}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, typeof content === "string" ? Buffer.from(content, "utf8") : content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export class StoreError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

/** Reads and validates JSON; errors name the file and the failing fields. */
export function readJson<T extends z.ZodType>(path: string, schema: T): z.infer<T> {
  if (!existsSync(path)) throw new StoreError(`missing file ${path}`, path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new StoreError(`invalid JSON in ${path}: ${(e as Error).message}`, path);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new StoreError(`schema validation failed for ${path}: ${summary}`, path, parsed.error.issues);
  }
  return parsed.data;
}

export function readJsonIfExists<T extends z.ZodType>(path: string, schema: T): z.infer<T> | null {
  return existsSync(path) ? readJson(path, schema) : null;
}

/** Versioned files like editplan-v003.json; returns sorted version numbers. */
export function listVersions(dir: string, prefix: string, ext = ".json"): number[] {
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${prefix}-v(\\d{3,})${ext.replace(".", "\\.")}$`);
  return readdirSync(dir)
    .map((f) => re.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

export function versionedPath(dir: string, prefix: string, version: number, ext = ".json"): string {
  return join(dir, `${prefix}-v${String(version).padStart(3, "0")}${ext}`);
}
