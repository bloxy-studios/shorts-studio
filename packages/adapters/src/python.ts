import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./env.ts";
import { run, type RunOptions } from "./proc.ts";
import { tool } from "./tools.ts";

export class PythonCommandError extends Error {
  constructor(
    readonly command: string,
    message: string,
    readonly trace?: string,
  ) {
    super(`python ${command}: ${message}`);
    this.name = "PythonCommandError";
  }
}

/**
 * Runs `python -m shorts_studio_py <command>` with JSON in/out files. The Python
 * helpers live in the read-only plugin tree; the interpreter is the runtime venv.
 */
export async function py<T>(command: string, args: Record<string, unknown>, opts: RunOptions = {}): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ss-py-"));
  const inPath = join(dir, "in.json");
  const outPath = join(dir, "out.json");
  writeFileSync(inPath, JSON.stringify(args));
  try {
    await run([tool("python"), "-m", "shorts_studio_py", command, "--in", inPath, "--out", outPath], {
      ...opts,
      allowFailure: true,
      env: { PYTHONPATH: paths().pythonSrc, PYTHONUNBUFFERED: "1", ...(opts.env ?? {}) },
    });
    let parsed: { ok: boolean; result?: T; error?: string; trace?: string };
    try {
      parsed = JSON.parse(readFileSync(outPath, "utf8"));
    } catch {
      throw new PythonCommandError(command, "no result written (interpreter crashed or missing packages; run `ss doctor`)");
    }
    if (!parsed.ok) throw new PythonCommandError(command, parsed.error ?? "unknown error", parsed.trace);
    return parsed.result as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
