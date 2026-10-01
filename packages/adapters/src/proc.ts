/**
 * Subprocess runner. Arguments are always passed as arrays (never interpolated
 * into a shell), secrets are redacted from logs, and every call is cancellable.
 */

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Milliseconds; the process is killed (SIGTERM then SIGKILL) on expiry. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with stderr lines (e.g. to parse ffmpeg progress). */
  onStderrLine?: (line: string) => void;
  onStdoutLine?: (line: string) => void;
  /** Resolve even on non-zero exit instead of throwing. */
  allowFailure?: boolean;
  stdin?: string | Uint8Array;
  /** Cap retained output to keep memory bounded on long jobs. */
  maxOutputBytes?: number;
  /** Keep stdout as raw bytes (e.g. rawvideo frames) in `stdoutBuffer`. */
  binary?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  /** Raw stdout when `binary` was requested. */
  stdoutBuffer?: Uint8Array;
  stderr: string;
  durationMs: number;
  command: string;
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
  ) {
    super(message);
    this.name = "ProcessError";
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /(--(?:cookies|password|username|token|api-key|access-token|header)[= ])(\S+)/gi,
  /([?&](?:token|key|signature|sig|access_token)=)[^&\s]+/gi,
  /(Authorization:\s*Bearer\s+)\S+/gi,
];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, "$1[REDACTED]"), text);
}

function quoteForDisplay(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function displayCommand(cmd: string[]): string {
  return redact(cmd.map(quoteForDisplay).join(" "));
}

async function pump(stream: ReadableStream<Uint8Array> | null, onLine: ((l: string) => void) | undefined, cap: number): Promise<string> {
  if (!stream) return "";
  const decoder = new TextDecoder();
  let kept = "";
  let pending = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (kept.length < cap) kept += text.slice(0, cap - kept.length);
    if (onLine) {
      pending += text;
      const parts = pending.split(/\r?\n|\r/);
      pending = parts.pop() ?? "";
      for (const p of parts) onLine(p);
    }
  }
  if (onLine && pending) onLine(pending);
  return kept;
}

async function collect(stream: ReadableStream<Uint8Array> | null, cap: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    if (size >= cap) continue;
    const take = chunk.subarray(0, cap - size);
    parts.push(take);
    size += take.length;
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function run(cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
  if (cmd.length === 0 || !cmd[0]) throw new Error("empty command");
  const started = performance.now();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...(opts.env ?? {}) })) if (v !== undefined) env[k] = v;
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env,
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let killedReason: string | null = null;
  const kill = (reason: string) => {
    if (killedReason) return;
    killedReason = reason;
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }, 3000).unref?.();
  };
  const timer = opts.timeoutMs ? setTimeout(() => kill(`timed out after ${opts.timeoutMs} ms`), opts.timeoutMs) : null;
  const onAbort = () => kill("cancelled");
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();

  const cap = opts.maxOutputBytes ?? (opts.binary ? 256 * 1024 * 1024 : 8 * 1024 * 1024);
  const [out, stderr, code] = await Promise.all([
    opts.binary ? collect(proc.stdout, cap) : pump(proc.stdout, opts.onStdoutLine, cap),
    pump(proc.stderr, opts.onStderrLine, 8 * 1024 * 1024),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);
  const stdout = typeof out === "string" ? out : "";
  const result: RunResult = { code, stdout, stderr, durationMs: performance.now() - started, command: displayCommand(cmd), ...(typeof out === "string" ? {} : { stdoutBuffer: out }) };
  if (killedReason) throw new ProcessError(`${cmd[0]} ${killedReason}`, result);
  if (code !== 0 && !opts.allowFailure) {
    const tail = redact(stderr.trim().split("\n").slice(-12).join("\n"));
    throw new ProcessError(`${cmd[0]} exited with code ${code}\n${tail}`, result);
  }
  return result;
}

/** Resolves an executable on PATH (or returns null). */
export function which(name: string): string | null {
  return Bun.which(name) ?? null;
}
