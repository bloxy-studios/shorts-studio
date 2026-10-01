/** Minimal, dependency-free argv parser: positionals, --k v, --k=v, --flag, --no-flag, repeated keys. */
export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        add(a.slice(2, eq), a.slice(eq + 1));
      } else if (a.startsWith("--no-")) {
        add(a.slice(5), "false");
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          add(a.slice(2), next);
          i++;
        } else {
          add(a.slice(2), "true");
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

export class Args {
  constructor(private readonly parsed: ParsedArgs) {}

  get positionals(): string[] {
    return this.parsed.positionals;
  }

  has(name: string): boolean {
    return this.parsed.flags.has(name);
  }

  str(name: string): string | undefined {
    const v = this.parsed.flags.get(name);
    return v ? v[v.length - 1] : undefined;
  }

  req(name: string): string {
    const v = this.str(name);
    if (v === undefined || v === "true") throw new ArgError(`--${name} <value> is required`);
    return v;
  }

  all(name: string): string[] {
    return this.parsed.flags.get(name) ?? [];
  }

  bool(name: string, dflt = false): boolean {
    const v = this.str(name);
    if (v === undefined) return dflt;
    return !["false", "0", "no", "off"].includes(v.toLowerCase());
  }

  num(name: string, dflt?: number): number | undefined {
    const v = this.str(name);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ArgError(`--${name} expects a number, got "${v}"`);
    return n;
  }

  pos(index: number, label: string): string {
    const v = this.parsed.positionals[index];
    if (v === undefined) throw new ArgError(`missing <${label}>`);
    return v;
  }
}
