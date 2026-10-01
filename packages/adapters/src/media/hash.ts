import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeJson } from "../../../core/src/index.ts";

/** Streaming SHA-256 of a file's bytes. */
export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return `sha256:${hasher.digest("hex")}`;
}

/**
 * Hash with a (path, size, mtime) memo in the cache directory so multi-GB sources
 * are hashed once per change, not on every command.
 */
export async function contentHash(path: string, cacheDir: string): Promise<string> {
  const st = statSync(path);
  const memoFile = join(cacheDir, "hash-memo.json");
  let memo: Record<string, { size: number; mtimeMs: number; hash: string }> = {};
  if (existsSync(memoFile)) {
    try {
      memo = JSON.parse(readFileSync(memoFile, "utf8"));
    } catch {
      memo = {};
    }
  }
  const hit = memo[path];
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.hash;
  const hash = await sha256File(path);
  memo[path] = { size: st.size, mtimeMs: st.mtimeMs, hash };
  writeJson(memoFile, memo);
  return hash;
}
