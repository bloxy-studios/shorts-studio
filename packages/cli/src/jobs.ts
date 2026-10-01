import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StageStateSchema, readJsonIfExists, writeJson, type StageState } from "../../core/src/index.ts";
import { P, nowIso, type Project } from "./project.ts";
import { info } from "./ui.ts";

/** Process-wide cancellation (Ctrl-C) so long stages stop cleanly and resume later. */
export const cancellation = new AbortController();
let sigintCount = 0;
process.on("SIGINT", () => {
  sigintCount++;
  if (sigintCount > 1) process.exit(130);
  process.stderr.write("\n⏹ cancelling — current stage will be marked cancelled; rerun the same command to resume\n");
  cancellation.abort();
});

export function hashInputs(inputs: Record<string, unknown>): string {
  const canonical = JSON.stringify(inputs, Object.keys(inputs).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

function stateFile(p: Project, stage: string): string {
  return join(P.state(p), "stages", `${stage.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

export function readStage(p: Project, stage: string): StageState | null {
  return readJsonIfExists(stateFile(p, stage), StageStateSchema);
}

export interface StageOptions {
  /** Force a rerun even when inputs are unchanged. */
  force?: boolean;
}

/**
 * Runs a stage once per unique input set. Completed stages whose outputs still
 * exist are skipped (cache hit); failures and cancellations are persisted so
 * `ss status` can explain them and a rerun resumes.
 */
export async function runStage<T>(
  p: Project,
  stage: string,
  inputs: Record<string, string>,
  fn: (signal: AbortSignal) => Promise<{ outputs: string[]; value: T; note?: string }>,
  opts: StageOptions = {},
): Promise<{ value: T | null; cached: boolean; state: StageState }> {
  const key = hashInputs(inputs);
  const prev = readStage(p, stage);
  if (!opts.force && prev && prev.status === "done" && prev.key === key && prev.outputs.every((o) => existsSync(o))) {
    info(`  ↺ ${stage}: cached (inputs unchanged)`);
    return { value: null, cached: true, state: prev };
  }
  if (cancellation.signal.aborted) throw new Error("cancelled");
  const running: StageState = StageStateSchema.parse({
    stage,
    key,
    status: "running",
    startedAt: nowIso(),
    inputs,
    outputs: [],
    attempts: (prev?.key === key ? prev.attempts : 0) + 1,
  });
  writeJson(stateFile(p, stage), running);
  try {
    const out = await fn(cancellation.signal);
    const done: StageState = { ...running, status: "done", finishedAt: nowIso(), outputs: out.outputs, ...(out.note ? { note: out.note } : {}) };
    writeJson(stateFile(p, stage), done);
    return { value: out.value, cached: false, state: done };
  } catch (e) {
    const status = cancellation.signal.aborted ? "cancelled" : "failed";
    writeJson(stateFile(p, stage), { ...running, status, finishedAt: nowIso(), error: (e as Error).message.slice(0, 2000) });
    throw e;
  }
}
