import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QAReportSchema, readJson, type QAReport, type Rule } from "../../../core/src/index.ts";
import type { Command } from "../registry.ts";
import { P, loadProject } from "../project.ts";
import { loadRender } from "../plans.ts";
import { briefDir, draftBrief, loadBrief, refineBrief } from "../director/brief.ts";
import { repairLoop } from "../director/repair.ts";

function latestQa(p: ReturnType<typeof loadProject>, clipId: string, renderId?: string): QAReport {
  const clip = p.config.clips.find((c) => c.id === clipId);
  const id = renderId ?? clip?.latestRenderId;
  if (!id) throw new Error(`clip ${clipId} has no render yet; run: shorts-studio render ${p.config.id} --clip ${clipId}`);
  const file = join(P.render(p, clipId, id), "qa.json");
  if (!existsSync(file)) throw new Error(`render ${id} has no qa.json; run: shorts-studio qa ${p.config.id} --clip ${clipId} --render ${id}`);
  return readJson(file, QAReportSchema);
}

export const directorCommands: Record<string, Command> = {
  brief: {
    summary: "Director brief: draft DIRECTOR_BRIEF + constraints from the plan and evidence, show it, or refine it from feedback",
    usage: 'shorts-studio brief draft|show|refine <project> --clip ID [--goal TEXT] [--audience TEXT] [--instruction TEXT]... | refine: --feedback TEXT [--rule-id ID --area AREA --rule TEXT [--hard]] [--remove RULE_ID]...',
    async run(args) {
      const sub = args.pos(0, "draft|show|refine");
      const p = loadProject(args.pos(1, "project"));
      const clipId = args.req("clip");
      if (sub === "draft") {
        const r = draftBrief(p, clipId, { ...(args.str("goal") ? { goal: args.str("goal")! } : {}), ...(args.str("audience") ? { audience: args.str("audience")! } : {}), instructions: args.all("instruction") });
        return { json: { version: r.brief.version, path: r.path, rules: r.brief.rules.length }, human: `${r.brief.version}: ${r.brief.rules.length} rules → ${r.path}\n(also ${join(briefDir(p, clipId), "DIRECTOR_BRIEF.md")})` };
      }
      if (sub === "show") {
        const b = loadBrief(p, clipId);
        if (!b) throw new Error(`no brief yet; run: shorts-studio brief draft ${p.config.id} --clip ${clipId}`);
        const md = join(briefDir(p, clipId), `${b.version}.md`);
        return { json: b, human: readFileSync(md, "utf8") };
      }
      if (sub === "refine") {
        const feedback = args.req("feedback");
        const upsert: Rule[] = args.str("rule")
          ? [{ id: args.str("rule-id") ?? `user-${Date.now().toString(36)}`, area: (args.str("area") ?? "editorial") as Rule["area"], rule: args.str("rule")!, hard: args.bool("hard"), source: "user", sourceRef: "feedback" }]
          : [];
        const r = refineBrief(p, clipId, { trigger: "user-feedback", evidence: feedback, summary: feedback, upsert, remove: args.all("remove") });
        return { json: { version: r.brief.version, path: r.path }, human: `${r.brief.version} → ${r.path}` };
      }
      throw new Error(`unknown brief subcommand "${sub}"`);
    },
  },
  repair: {
    summary: "Bounded critique→refine→verify loop: targeted fixes for QA findings, re-render, re-check (budget from project config)",
    usage: "shorts-studio repair <project> --clip ID [--render ID] [--max-passes N] [--max-minutes M]",
    async run(args) {
      const p = loadProject(args.pos(0, "project"));
      const clipId = args.req("clip");
      if (!loadBrief(p, clipId)) draftBrief(p, clipId);
      const qa = latestQa(p, clipId, args.str("render"));
      const res = await repairLoop(p, clipId, { qa }, { ...(args.num("max-passes") !== undefined ? { maxPasses: args.num("max-passes")! } : {}), ...(args.num("max-minutes") !== undefined ? { maxMinutes: args.num("max-minutes")! } : {}) });
      const last = res.passes[res.passes.length - 1];
      return {
        json: res,
        human: [
          `repair ${clipId}: ${res.passes.length} pass(es); stopped: ${res.stoppedBecause}; final verdict ${res.finalVerdict}${last ? ` (${last.renderId}, plan v${last.planVersion}, ${last.briefVersion})` : " (no change needed)"}`,
          ...res.passes.map((x) => `  pass ${x.pass} → ${x.renderId} ${x.verdict}: ${x.actions.join("; ")}`),
          ...(res.unresolved.length ? ["  unresolved:", ...res.unresolved.map((u) => `    - ${u}`)] : []),
        ].join("\n"),
      };
    },
  },
};

void loadRender;
