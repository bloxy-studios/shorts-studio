#!/usr/bin/env bun
/**
 * shorts-studio — deterministic CLI behind the Shorts Studio Claude Code plugin.
 * Human progress → stderr; with --json, exactly one JSON result → stdout.
 */
import { Args, ArgError, parseArgs } from "./args.ts";
import { configureOutput, result, warn } from "./ui.ts";
import { setWorkspace } from "../../adapters/src/env.ts";
import { MissingToolError } from "../../adapters/src/tools.ts";
import { ProcessError } from "../../adapters/src/proc.ts";
import { COMMANDS } from "./registry.ts";

function usage(): string {
  const lines = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(12)} ${c.summary}`);
  return [
    "usage: shorts-studio <command> [args] [--workspace DIR] [--data-dir DIR] [--json] [--quiet]",
    "",
    "commands:",
    ...lines,
    "",
    "Run `shorts-studio <command> --help` for details.",
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const args = new Args(parsed);
  configureOutput({ json: args.bool("json"), quiet: args.bool("quiet") });
  const ws = args.str("workspace");
  if (ws) setWorkspace(ws);
  const dataDir = args.str("data-dir");
  if (dataDir && dataDir !== "true") process.env.SHORTS_STUDIO_HOME = dataDir;

  const name = args.positionals[0];
  if (!name || name === "help" || (!name && args.has("help"))) {
    process.stdout.write(`${usage()}\n`);
    return name ? 0 : 1;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    process.stderr.write(`unknown command "${name}"\n\n${usage()}\n`);
    return 2;
  }
  if (args.has("help")) {
    process.stdout.write(`${cmd.usage}\n`);
    return 0;
  }
  const rest = new Args({ positionals: args.positionals.slice(1), flags: parsed.flags });
  const value = await cmd.run(rest);
  if (value !== undefined) result(value.json, value.human);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof ArgError) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(2);
    }
    if (e instanceof MissingToolError) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(3);
    }
    if (e instanceof ProcessError) {
      process.stderr.write(`error: ${e.message}\n  command: ${e.result.command}\n`);
      process.exit(4);
    }
    const err = e as Error;
    warn(err.message);
    if (process.env.SS_DEBUG) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  },
);
