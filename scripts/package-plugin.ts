/**
 * Assembles a clean, installable plugin + marketplace in release/ (only plugin files:
 * no runtime, projects, node_modules, tests or build prompt), validates it, and prints
 * the install commands.   bun scripts/package-plugin.ts [outDir]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const out = resolve(process.argv[2] ?? join(root, "release"));
const pluginDir = join(out, "shorts-studio");

const INCLUDE = [".claude-plugin/plugin.json", "bin", "dist/shorts-studio.js", "hooks", "skills", "agents", "references", "presets", "templates", "assets", "python/requirements-base.txt", "python/shorts_studio_py", "docs", "README.md", "ARCHITECTURE.md", "ACCEPTANCE.md", "CHECKLIST.md", "LICENSE"];
const SKIP = /(__pycache__|\.pytest_cache|\.DS_Store|\.pyc$)/;

const build = Bun.spawnSync(["bun", "build", "packages/cli/src/main.ts", "--target=bun", "--outfile", "dist/shorts-studio.js"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) throw new Error("bundle build failed");

rmSync(out, { recursive: true, force: true });
mkdirSync(pluginDir, { recursive: true });
for (const rel of INCLUDE) {
  const src = join(root, rel);
  if (!existsSync(src)) throw new Error(`missing ${rel}`);
  cpSync(src, join(pluginDir, rel), { recursive: true, filter: (s) => !SKIP.test(s) });
}
const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")) as { name: string; version: string; description: string };
mkdirSync(join(out, ".claude-plugin"), { recursive: true });
writeFileSync(
  join(out, ".claude-plugin", "marketplace.json"),
  `${JSON.stringify(
    {
      $schema: "https://json.schemastore.org/claude-code-marketplace.json",
      name: "shorts-studio",
      description: "Shorts Studio — code-driven short-video editing for Claude Code",
      owner: { name: "Shorts Studio" },
      plugins: [{ name: plugin.name, source: "./shorts-studio", description: plugin.description, version: plugin.version, category: "media", tags: ["video", "shorts", "editing", "captions"] }],
    },
    null,
    2,
  )}\n`,
);

function size(p: string): number {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return [...new Bun.Glob("**/*").scanSync({ cwd: p, dot: true, onlyFiles: true })].reduce((a, f) => a + statSync(join(p, f)).size, 0);
}
console.log(`release: ${out} (${(size(out) / 1e6).toFixed(1)} MB)`);
console.log(`install: claude plugin marketplace add ${out} && claude plugin install ${plugin.name}@shorts-studio`);
