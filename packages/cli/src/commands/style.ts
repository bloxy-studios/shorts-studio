/**
 * Design + style learning: workspace brand presets (structured overrides of a base
 * preset) and explicit project/workspace preferences, plus reference import that keeps
 * the original text beside a normalized interpretation the agent fills in.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { CaptionStyleSchema, PresetSchema } from "../../../core/src/index.ts";
import { listIds, loadCaptionStyle, loadPreset } from "../../../adapters/src/presets.ts";
import { paths } from "../../../adapters/src/env.ts";
import type { Command } from "../registry.ts";
import { P, loadProject, nowIso } from "../project.ts";

function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split(".");
  if (!head) throw new Error(`empty --set path`);
  if (rest.length === 0) return { ...obj, [head]: value };
  const child = (obj[head] && typeof obj[head] === "object" ? obj[head] : {}) as Record<string, unknown>;
  return { ...obj, [head]: setPath(child, rest.join("."), value) };
}

function parseSets(sets: string[]): Array<[string, unknown]> {
  return sets.map((s) => {
    const i = s.indexOf("=");
    if (i < 1) throw new Error(`--set expects path=value (JSON value), got "${s}"`);
    const raw = s.slice(i + 1);
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      /* plain string */
    }
    return [s.slice(0, i), value];
  });
}

const workspacePresets = (kind: "editorial" | "captions") => join(paths().workspace, ".shorts-studio", "presets", kind);
const workspacePrefs = () => join(paths().workspace, ".shorts-studio", "PREFERENCES.md");

export const styleCommands: Record<string, Command> = {
  preset: {
    summary: "Brand/design presets: list, show, or create a workspace preset or caption style from a base with validated overrides",
    usage: "shorts-studio preset list | show <id> [--captions] | create <new-id> --from <base> [--captions] [--name TEXT] [--set path=JSON]...",
    async run(args) {
      const sub = args.pos(0, "list|show|create");
      const kind = args.bool("captions") ? "captions" : "editorial";
      if (sub === "list") {
        const ed = listIds("editorial");
        const cs = listIds("captions");
        return { json: { presets: ed, captionStyles: cs, workspaceDir: workspacePresets("editorial") }, human: `presets: ${ed.join(", ")}\ncaption styles: ${cs.join(", ")}\n(workspace presets live in ${join(paths().workspace, ".shorts-studio", "presets")})` };
      }
      if (sub === "show") {
        const id = args.pos(1, "id");
        const v = kind === "captions" ? loadCaptionStyle(id) : loadPreset(id);
        return { json: v, human: JSON.stringify(v, null, 2) };
      }
      if (sub === "create") {
        const id = args.pos(1, "new-id");
        if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) throw new Error("preset id: lowercase letters, digits and dashes");
        const base = (kind === "captions" ? loadCaptionStyle(args.req("from")) : loadPreset(args.req("from"))) as unknown as Record<string, unknown>;
        let next: Record<string, unknown> = { ...base, id, version: "1.0.0", name: args.str("name") ?? id, description: `${args.str("name") ?? id} — derived from ${args.req("from")} on ${nowIso().slice(0, 10)}` };
        for (const [path, value] of parseSets(args.all("set"))) next = setPath(next, path, value);
        const parsed = kind === "captions" ? CaptionStyleSchema.safeParse(next) : PresetSchema.safeParse(next);
        if (!parsed.success) throw new Error(`invalid ${kind} preset: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        const dir = workspacePresets(kind);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${id}.json`);
        if (existsSync(file) && !args.bool("force")) throw new Error(`${file} exists; pass --force to replace it`);
        writeFileSync(file, `${JSON.stringify(parsed.data, null, 2)}\n`);
        return { json: { id, file }, human: `${kind === "captions" ? "caption style" : "preset"} ${id} → ${file}` };
      }
      throw new Error(`unknown preset subcommand "${sub}"`);
    },
  },
  prefs: {
    summary: "Preferences: list, add (explicit or tentative; --default only when the user says 'save this as my default'), or import a reference prompt/file",
    usage: 'shorts-studio prefs list <project> | add <project> "TEXT" [--area AREA] [--tentative] [--default] | import <project> FILE [--name NAME]',
    async run(args) {
      const sub = args.pos(0, "list|add|import");
      const p = loadProject(args.pos(1, "project"));
      if (sub === "list") {
        const proj = existsSync(P.preferences(p)) ? readFileSync(P.preferences(p), "utf8") : "";
        const ws = existsSync(workspacePrefs()) ? readFileSync(workspacePrefs(), "utf8") : "";
        return { json: { project: proj, workspace: ws }, human: `# project (${P.preferences(p)})\n${proj || "(none)"}\n# workspace defaults (${workspacePrefs()})\n${ws || "(none)"}` };
      }
      if (sub === "add") {
        const text = args.pos(2, "TEXT");
        const area = args.str("area") ?? "editorial";
        const tentative = args.bool("tentative");
        if (tentative && args.bool("default")) throw new Error("a tentative inference cannot become a default; ask the user first");
        const line = `- [${area}] ${text}${tentative ? " *(tentative)*" : ""} — ${nowIso().slice(0, 10)}\n`;
        writeFileSync(P.preferences(p), `${existsSync(P.preferences(p)) ? readFileSync(P.preferences(p), "utf8") : ""}${line}`);
        if (args.bool("default")) {
          mkdirSync(join(paths().workspace, ".shorts-studio"), { recursive: true });
          const ws = existsSync(workspacePrefs()) ? readFileSync(workspacePrefs(), "utf8") : "# Workspace defaults\n\nSaved only on an explicit \"save this as my default\".\n\n";
          writeFileSync(workspacePrefs(), `${ws}${line}`);
        }
        return { json: { added: line.trim(), default: args.bool("default") }, human: `added to ${P.preferences(p)}${args.bool("default") ? ` and ${workspacePrefs()}` : ""}: ${line.trim()}` };
      }
      if (sub === "import") {
        const file = args.pos(2, "FILE");
        if (!existsSync(file)) throw new Error(`no such file ${file}`);
        const name = (args.str("name") ?? basename(file, extname(file))).replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
        const dir = join(P.brief(p), "references");
        mkdirSync(dir, { recursive: true });
        const original = join(dir, `${name}${extname(file) || ".md"}`);
        copyFileSync(file, original);
        const interp = join(dir, `${name}.interpretation.md`);
        if (!existsSync(interp)) {
          writeFileSync(
            interp,
            [
              `# Interpretation of ${basename(file)}`,
              "",
              `Original kept verbatim at \`${basename(original)}\`. Fill every section; keep the author's intent and record corrections.`,
              "",
              "## Style specification (readable)",
              "",
              "## Design tokens and caption variants",
              "",
              "## Editing and audio constraints (units, tolerances)",
              "",
              "## Reusable composition components",
              "",
              "## Validation checklist",
              "",
              "## Conflict-resolution rules",
              "",
              "## Technical corrections (and why)",
              "",
            ].join("\n"),
          );
        }
        return { json: { original, interpretation: interp }, human: `kept ${original}\ninterpretation to complete: ${interp}\nThen: shorts-studio preset create <id> --from <base> --set ...` };
      }
      throw new Error(`unknown prefs subcommand "${sub}"`);
    },
  },
};
