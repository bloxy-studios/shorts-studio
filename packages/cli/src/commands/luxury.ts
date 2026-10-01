import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EditPlanSchema, flicksToSeconds, validatePlan, writeJson, type EditPlan, type MetricsTable } from "../../../core/src/index.ts";
import { GraphicsBriefSchema, type CompiledGraphic, type GraphicsBrief } from "../../../core/src/luxury/graphics.ts";
import { iconNames } from "../../../adapters/src/render/luxury-icons.ts";
import { writeLuxuryComposition } from "../../../adapters/src/render/luxury.ts";
import { hfLint, hfSnapshot } from "../../../adapters/src/hyperframes.ts";
import { loadPreset } from "../../../adapters/src/presets.ts";
import { paths } from "../../../adapters/src/env.ts";
import type { Command } from "../registry.ts";
import { P, loadProject, nowIso, type Project } from "../project.ts";
import { loadPlan, nextPlanVersion, savePlan } from "../plans.ts";
import { buildLuxury, type LuxuryResult } from "../luxury/plan.ts";
import { loadSource } from "./ingest.ts";
import { loadVisual } from "./analyze.ts";
import { info, warn } from "../ui.ts";

export const luxuryDir = (p: Project, clipId: string) => join(P.clip(p, clipId), "luxury");

export function loadBrief(p: Project, clipId: string, file?: string): GraphicsBrief {
  const path = file ?? join(luxuryDir(p, clipId), "graphics.json");
  if (!existsSync(path)) return GraphicsBriefSchema.parse({ schemaVersion: 1 });
  const parsed = GraphicsBriefSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`graphics brief ${path} is invalid:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  return parsed.data;
}

/** Applies Luxury Tech to the clip's current plan and saves it as a new version. */
export function applyLuxury(p: Project, clipId: string, opts: { brief?: string; title?: string } = {}): { plan: EditPlan; result: LuxuryResult; tablePath: string } {
  const base = loadPlan(p, clipId);
  const preset = loadPreset("luxury-tech");
  const pictureId = base.segments[0]!.picture.sourceId;
  const camera = loadSource(p, pictureId);
  const brief = loadBrief(p, clipId, opts.brief);
  const result = buildLuxury({ plan: base, preset, camera, visual: loadVisual(p, pictureId), brief, ...(opts.title ? { title: opts.title } : {}) });
  const plan = EditPlanSchema.parse({
    ...result.plan,
    version: nextPlanVersion(p, clipId),
    parentVersion: base.version,
    createdAt: nowIso(),
    createdBy: "director",
    presetId: preset.id,
    presetVersion: preset.version,
    changeSummary: `Luxury Tech: ${result.plan.layoutRuns.length} layout runs (${["lt-split", "lt-full-visual", "lt-full-camera"].map((l) => `${result.plan.layoutRuns.filter((r) => r.layout === l).length} ${l.replace("lt-", "")}`).join(", ")}), ${result.plan.graphics.length} graphics, ${result.plan.audio.sfx.length} SFX`,
    changes: [{ path: "layoutRuns", op: "replace", reason: "Luxury Tech layout plan (eye-contact gated)" }, { path: "graphics", op: "replace", reason: brief.runs.length ? "director graphics brief" : "auto graphics (no brief)" }],
  });
  const frames = new Map([[camera.id, { width: camera.probe.video!.displayWidth, height: camera.probe.video!.displayHeight, durationFlicks: camera.probe.durationFlicks }]]);
  const errors = validatePlan(plan, { sourceFrames: frames }).filter((i) => i.severity === "error");
  if (errors.length) throw new Error(`Luxury plan invalid:\n${errors.map((e) => `  ${e.code}: ${e.message}`).join("\n")}`);
  savePlan(p, plan);
  const dir = luxuryDir(p, clipId);
  mkdirSync(dir, { recursive: true });
  const tablePath = join(dir, "layout-runs.md");
  const notes = [
    "",
    "## Warnings",
    ...(result.warnings.length ? result.warnings.map((w) => `- ${w}`) : ["- none"]),
    "",
    "## Plan-level exceptions",
    ...(result.exceptions.length ? result.exceptions.map((e) => `- ${e}`) : ["- none"]),
    "",
    `Split transform: source × ${result.geometry.s.toFixed(4)} at (${Math.round(result.geometry.X)}, ${Math.round(result.geometry.Y)}); head top y=${Math.round(result.geometry.headTopCanvas)}; eyes y=${Math.round(result.geometry.eyeCanvasY)}${result.geometry.contained ? " — contained card" : ""}.`,
  ];
  writeFileSync(tablePath, `${result.table.replace(/# Layout runs — (\S+) v\d+/, `# Layout runs — $1 v${plan.version}`)}\n${notes.join("\n")}\n`);
  writeJson(join(dir, "layout-runs.json"), { version: plan.version, runs: plan.layoutRuns, graphics: plan.graphics.map((g) => ({ id: g.id, runId: g.runId, subject: g.subject, auto: (g.props as { auto?: boolean }).auto })), exceptions: result.exceptions, warnings: result.warnings });
  return { plan, result, tablePath };
}

/** Starter brief listing each line with its words, for the director to fill in. */
function briefTemplate(plan: EditPlan): Record<string, unknown> {
  const words = plan.captions?.chunks.flatMap((c) => c.words) ?? [];
  const lines = plan.segments.map((s) => ({ id: s.lineId ?? s.id, text: words.filter((w) => s.wordIds.includes(w.sourceWordId)).map((w) => w.text).join(" ") }));
  return {
    schemaVersion: 1,
    $lines: lines,
    $icons: iconNames(),
    $itemKinds: ["card", "stat", "list", "tile", "code", "chat", "document", "image", "radar", "text", "connector"],
    intents: Object.fromEntries(lines.map((l, i) => [l.id, i === 0 ? "hook" : i === lines.length - 1 ? "outro" : "point"])),
    title: null,
    cta: null,
    runs: [],
  };
}

export const luxuryCommands: Record<string, Command> = {
  luxury: {
    summary: "Luxury Tech: plan layout runs + graphics from a director brief, preview graphics frames, or write a brief template",
    usage: "shorts-studio luxury plan|preview|brief <project> --clip ID [--brief FILE] [--title TEXT] [--at SECONDS,...]",
    async run(args) {
      const sub = args.pos(0, "plan|preview|brief");
      const p = loadProject(args.pos(1, "project"));
      const clipId = args.req("clip");
      if (sub === "brief") {
        const out = join(luxuryDir(p, clipId), "graphics.json");
        mkdirSync(luxuryDir(p, clipId), { recursive: true });
        if (existsSync(out) && !args.bool("force")) throw new Error(`${out} exists; pass --force to overwrite`);
        writeFileSync(out, `${JSON.stringify(briefTemplate(loadPlan(p, clipId)), null, 2)}\n`);
        return { json: { brief: out }, human: `brief template: ${out}` };
      }
      if (sub === "plan") {
        const { plan, result, tablePath } = applyLuxury(p, clipId, { ...(args.str("brief") ? { brief: args.str("brief")! } : {}), ...(args.str("title") ? { title: args.str("title")! } : {}) });
        for (const w of result.warnings) warn(w);
        return {
          json: { clipId, version: plan.version, table: tablePath, runs: plan.layoutRuns.map((r) => ({ id: r.id, layout: r.layout, start: flicksToSeconds(r.outStart), end: flicksToSeconds(r.outEnd), reason: r.reason, exceptions: r.exceptions })), exceptions: result.exceptions, warnings: result.warnings },
          human: `${readFileSync(tablePath, "utf8")}\nplan v${plan.version} saved — render with: shorts-studio render ${p.config.id} --clip ${clipId}`,
        };
      }
      if (sub === "preview") {
        // Lint + snapshot every graphics run at its landing frame, events and end — no full render.
        const plan = loadPlan(p, clipId);
        const metrics = JSON.parse(readFileSync(join(paths().fontsDir, "metrics.json"), "utf8")) as MetricsTable;
        const root = join(P.review(p), "luxury", `${clipId}-v${plan.version}`);
        rmSync(root, { recursive: true, force: true });
        const sheets: string[] = [];
        for (const g of plan.graphics) {
          const run = plan.layoutRuns.find((r) => r.id === g.runId)!;
          const compiled = (g.props as { compiled: CompiledGraphic }).compiled;
          const dir = join(root, g.runId);
          mkdirSync(dir, { recursive: true });
          const frames = Math.round((run.outEnd - run.outStart) / (705_600_000 / 60));
          writeLuxuryComposition(dir, compiled, { fps: 60, frames, split: run.layout === "lt-split", cover: (g.props as { cover?: boolean }).cover && plan.cover ? { title: plan.cover.title } : null, motionBlur: { enabled: true, shutter: 0.75, maxSigma: 40 }, subframes: 1, metrics });
          const lint = await hfLint(dir);
          if (!lint.ok) warn(`${g.runId}: lint ${JSON.stringify(lint.errors).slice(0, 300)}`);
          const dur = compiled.durationS;
          const times = new Set<number>([0, ...compiled.moves.map((m) => Math.min(dur - 0.01, m.t0 + m.dur)), ...compiled.actions.filter((a) => a.kind !== "type").map((a) => Math.min(dur - 0.01, a.t + a.dur + 0.05)), dur - 1 / 60]);
          const shots = await hfSnapshot(dir, [...times].sort((a, b) => a - b).slice(0, 8), join(dir, "shots"));
          const sheet = join(dir, "shots", "contact-sheet.jpg");
          if (existsSync(sheet)) sheets.push(sheet);
          info(`  ${g.runId} ${run.layout.replace("lt-", "")} "${g.subject}": ${shots.length} frames`);
        }
        return { json: { sheets }, human: `graphics previews:\n${sheets.map((s) => `  ${s}`).join("\n")}\nInspect them (Read the images) before rendering.` };
      }
      throw new Error(`unknown luxury subcommand "${sub}" (plan|preview|brief)`);
    },
  },
};
