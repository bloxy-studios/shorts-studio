import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./env.ts";
import { ProcessError, run, type RunOptions } from "./proc.ts";

/** Pinned versions verified on the reference machine (docs/COMPATIBILITY.md). */
export const HYPERFRAMES_VERSION = "0.8.97";
export const GSAP_VERSION = "3.14.2";
export const CHROME_HEADLESS_SHELL = "152.0.7977.30";

export function hyperframesBin(): string | null {
  const bin = join(paths().nodeDir, "node_modules", ".bin", "hyperframes");
  return existsSync(bin) ? bin : null;
}

export function gsapScript(): string | null {
  const f = join(paths().nodeDir, "node_modules", "gsap", "dist", "gsap.min.js");
  return existsSync(f) ? f : null;
}

/** Locates the pinned chrome-headless-shell inside the runtime (render ignores other installs). */
export function chromeHeadlessShell(): string | null {
  const root = join(paths().runtimeHome, "browsers", "chrome-headless-shell");
  if (!existsSync(root)) return null;
  for (const platformDir of readdirSync(root)) {
    if (!platformDir.includes(CHROME_HEADLESS_SHELL)) continue;
    const base = join(root, platformDir);
    for (const sub of readdirSync(base)) {
      const exe = join(base, sub, "chrome-headless-shell");
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

/** Environment for every HyperFrames call: no telemetry, no update checks, pinned browser, bounded caches. */
export function hyperframesEnv(): Record<string, string> {
  const p = paths();
  const env: Record<string, string> = {
    HYPERFRAMES_NO_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    HYPERFRAMES_FONT_CACHE_DIR: join(p.runtimeHome, "cache", "hf-fonts"),
    HYPERFRAMES_EXTRACT_CACHE_DIR: join(p.runtimeHome, "cache", "hf-extract"),
    HYPERFRAMES_EXTRACT_CACHE_MAX_MB: "1024",
    FFMPEG_PROCESS_TIMEOUT_MS: "1800000",
    FFMPEG_ENCODE_TIMEOUT_MS: "3600000",
    FFMPEG_STREAMING_TIMEOUT_MS: "1800000",
    PRODUCER_PLAYER_READY_TIMEOUT_MS: "180000",
    PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS: "900000",
  };
  const chrome = chromeHeadlessShell();
  if (chrome) env.HYPERFRAMES_BROWSER_PATH = chrome;
  // Keep HyperFrames on the same ffmpeg the CLI resolved.
  if (process.env.SS_FFMPEG_BIN) env.PATH = `${join(process.env.SS_FFMPEG_BIN, "..")}:${process.env.PATH ?? ""}`;
  return env;
}

function requireBin(): string {
  const bin = hyperframesBin();
  if (!bin) throw new Error("HyperFrames is not installed in the runtime; run `shorts-studio doctor --setup`");
  return bin;
}

export interface LintFinding {
  severity: string;
  code: string;
  message: string;
}

export async function hfLint(dir: string, opts: RunOptions = {}): Promise<{ ok: boolean; errors: LintFinding[]; warnings: LintFinding[]; raw: string }> {
  const res = await run([requireBin(), "lint", dir, "--json"], { ...opts, allowFailure: true, env: { ...hyperframesEnv(), ...(opts.env ?? {}) }, timeoutMs: 300_000 });
  const raw = res.stdout.trim();
  const errors: LintFinding[] = [];
  const warnings: LintFinding[] = [];
  try {
    const json = JSON.parse(raw.slice(raw.indexOf("{")));
    const findings: Array<Record<string, unknown>> = Array.isArray(json.findings) ? json.findings : Array.isArray(json) ? json : [];
    for (const f of findings) {
      const item = { severity: String(f.severity ?? f.level ?? ""), code: String(f.code ?? f.rule ?? f.id ?? ""), message: String(f.message ?? "") };
      if (item.severity === "error") errors.push(item);
      else if (item.severity === "warning") warnings.push(item);
    }
  } catch {
    if (res.code !== 0) errors.push({ severity: "error", code: "lint-unparsed", message: (res.stderr || raw).slice(-1500) });
  }
  return { ok: res.code === 0 && errors.length === 0, errors, warnings, raw };
}

export interface RenderRequest {
  dir: string;
  output: string;
  fps: string;
  format: "mp4" | "png-sequence" | "mov" | "webm";
  quality?: "draft" | "looks" | "standard" | "high" | "delivery";
  variablesFile?: string;
  composition?: string;
  strict?: boolean;
}

const RETRYABLE = /FFmpeg cannot start|Browser not available|Target closed|Protocol error|Navigation timeout/i;

/**
 * Renders a composition. Retries once on the known transient failures measured
 * on slow machines (5 s ffmpeg preflight, browser start-up) — never on lint errors.
 */
export async function hfRender(req: RenderRequest, opts: RunOptions & { onProgress?: (line: string) => void } = {}): Promise<{ durationMs: number; log: string }> {
  const bin = requireBin();
  mkdirSync(join(req.output, req.format === "png-sequence" ? "." : ".."), { recursive: true });
  const args = [bin, "render", req.dir, "-o", req.output, "--fps", req.fps, "--format", req.format, "--quality", req.quality ?? "looks", "--quiet"];
  if (req.variablesFile) args.push("--variables-file", req.variablesFile);
  if (req.composition) args.push("--composition", req.composition);
  if (req.strict !== false) args.push("--strict");
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await run(args, {
        timeoutMs: 6 * 3600_000,
        ...opts,
        env: { ...hyperframesEnv(), ...(opts.env ?? {}) },
        onStderrLine: (l) => opts.onProgress?.(l),
        onStdoutLine: (l) => opts.onProgress?.(l),
      });
      return { durationMs: res.durationMs, log: `${res.stdout}\n${res.stderr}`.slice(-20_000) };
    } catch (e) {
      lastErr = e;
      const text = e instanceof ProcessError ? `${e.result.stderr}\n${e.result.stdout}` : String(e);
      if (opts.signal?.aborted || !RETRYABLE.test(text) || attempt === 1) throw e;
      await run([process.env.SS_FFMPEG_BIN ?? "ffmpeg", "-version"], { allowFailure: true, timeoutMs: 60_000 });
    }
  }
  throw lastErr;
}

export async function hfSnapshot(dir: string, timesSec: number[], outDir: string, opts: RunOptions = {}): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  await run([requireBin(), "snapshot", dir, "-o", outDir, "--at", timesSec.map((t) => t.toFixed(3)).join(","), "--no-end", "--describe", "false"], {
    timeoutMs: 900_000,
    ...opts,
    env: { ...hyperframesEnv(), ...(opts.env ?? {}) },
  });
  return readdirSync(outDir)
    .filter((f) => f.endsWith(".png"))
    .sort()
    .map((f) => join(outDir, f));
}

export async function hfVersion(): Promise<string | null> {
  const bin = hyperframesBin();
  if (!bin) return null;
  const r = await run([bin, "--version"], { allowFailure: true, timeoutMs: 60_000, env: hyperframesEnv() });
  return r.stdout.trim() || null;
}

/**
 * Person matte via HyperFrames' local background removal (u2net_human_seg, ONNX on CPU here).
 * Output keeps the input's frame count and timing; .mov = ProRes 4444 with alpha.
 */
export async function hfRemoveBackground(input: string, output: string, opts: RunOptions & { onProgress?: (line: string) => void } = {}): Promise<{ durationMs: number }> {
  const res = await run([requireBin(), "remove-background", input, "-o", output, "--device", "auto"], {
    timeoutMs: 6 * 3600_000,
    ...opts,
    env: { ...hyperframesEnv(), ...(opts.env ?? {}) },
    onStderrLine: (l) => opts.onProgress?.(l),
    onStdoutLine: (l) => opts.onProgress?.(l),
  });
  return { durationMs: res.durationMs };
}
