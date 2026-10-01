/**
 * Human progress goes to stderr (concise, stage-level); machine results go to
 * stdout as one JSON document when --json is set, so skills can parse output.
 */
let jsonMode = false;
let quiet = false;

export function configureOutput(opts: { json: boolean; quiet: boolean }): void {
  jsonMode = opts.json;
  quiet = opts.quiet;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

export function info(message: string): void {
  if (!quiet) process.stderr.write(`${message}\n`);
}

export function stage(name: string, detail = ""): void {
  if (!quiet) process.stderr.write(`▸ ${name}${detail ? ` — ${detail}` : ""}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`⚠ ${message}\n`);
}

export function result(value: unknown, human?: string): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else if (human !== undefined) {
    process.stdout.write(`${human}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}

/** Throttled progress for long loops (at most every 2 s). */
export function progressReporter(label: string): (fraction: number, detail?: string) => void {
  let last = 0;
  return (fraction, detail) => {
    const now = performance.now();
    if (now - last < 2000 && fraction < 1) return;
    last = now;
    info(`  ${label} ${Math.round(fraction * 100)}%${detail ? ` ${detail}` : ""}`);
  };
}

export function table(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return "(none)";
  const cols = Object.keys(rows[0]!);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i]!)).join("  ");
  return [line(cols), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(cols.map((c) => String(r[c] ?? ""))))].join("\n");
}
