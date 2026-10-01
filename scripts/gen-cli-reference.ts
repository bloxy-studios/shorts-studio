/**
 * Regenerates references/cli.md from the live command registry, so skills never
 * document a command or flag the CLI does not have.  bun scripts/gen-cli-reference.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../packages/cli/src/registry.ts";

const lines = [
  "# Shorts Studio CLI reference",
  "",
  "Generated from the command registry by `bun scripts/gen-cli-reference.ts` — do not edit by hand.",
  "Every command accepts `--json` (machine-readable result on stdout), `--quiet`, `--workspace DIR` and `--data-dir DIR`.",
  "In skills the binary is `\"${CLAUDE_PLUGIN_ROOT}/bin/shorts-studio\"` (also on PATH as `shorts-studio`).",
  "",
  ...Object.entries(COMMANDS)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, c]) => [`## \`${name}\``, "", c.summary, "", "```", c.usage, "```", ""]),
];
writeFileSync(join(import.meta.dir, "..", "references", "cli.md"), lines.join("\n"));
console.log(`references/cli.md: ${Object.keys(COMMANDS).length} commands`);
