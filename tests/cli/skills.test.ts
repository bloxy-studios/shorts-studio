import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SKILLS = join(ROOT, "skills");
const INTERNAL = new Set(["ingest", "transcribe", "director", "quality-check"]);
const KNOWN_FIELDS = new Set([
  "name",
  "description",
  "when_to_use",
  "argument-hint",
  "arguments",
  "allowed-tools",
  "disallowed-tools",
  "disable-model-invocation",
  "user-invocable",
  "model",
  "effort",
  "context",
  "agent",
  "background",
  "hooks",
  "paths",
  "shell",
  "metadata",
  "license",
  "compatibility",
]);

function frontmatter(file: string): { meta: Record<string, unknown>; body: string } {
  const text = readFileSync(file, "utf8");
  expect(text.startsWith("---\n")).toBe(true);
  const end = text.indexOf("\n---\n", 4);
  expect(end).toBeGreaterThan(0);
  const meta = Bun.YAML.parse(text.slice(4, end)) as Record<string, unknown>;
  return { meta, body: text.slice(end + 5) };
}

describe("plugin skills", () => {
  const dirs = readdirSync(SKILLS).filter((d) => existsSync(join(SKILLS, d, "SKILL.md")));

  test("every skill has parseable frontmatter with known fields only", () => {
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      const { meta } = frontmatter(join(SKILLS, d, "SKILL.md"));
      expect(meta.name).toBe(d);
      expect(typeof meta.description).toBe("string");
      for (const k of Object.keys(meta)) expect(KNOWN_FIELDS.has(k)).toBe(true);
      const listing = `${meta.description ?? ""} ${meta.when_to_use ?? ""}`;
      expect(listing.length).toBeLessThanOrEqual(1536);
    }
  });

  test("internal skills are hidden from the slash menu but stay model-invocable", () => {
    for (const d of dirs.filter((x) => INTERNAL.has(x))) {
      const { meta } = frontmatter(join(SKILLS, d, "SKILL.md"));
      expect(meta["user-invocable"]).toBe(false);
      expect(meta["disable-model-invocation"]).toBeUndefined();
    }
  });

  test("skills only pre-approve the Shorts Studio CLI (no broad shell grants)", () => {
    for (const d of dirs) {
      const { meta } = frontmatter(join(SKILLS, d, "SKILL.md"));
      const tools = String(meta["allowed-tools"] ?? "");
      expect(tools).not.toMatch(/Bash\(\*\)|Bash\(bun \*\)|Bash\(python/);
    }
  });

  test("every referenced plugin file exists and bodies stay under 500 lines", () => {
    for (const d of dirs) {
      const { body } = frontmatter(join(SKILLS, d, "SKILL.md"));
      expect(body.split("\n").length).toBeLessThan(500);
      for (const m of body.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+\.md)/g)) {
        expect(existsSync(join(ROOT, m[1]!))).toBe(true);
      }
    }
  });
});
