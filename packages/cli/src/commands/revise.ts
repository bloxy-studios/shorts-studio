import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validatePlan, writeJson, type EditPlan, type MetricsTable } from "../../../core/src/index.ts";
import { loadCaptionStyle, loadPreset } from "../../../adapters/src/presets.ts";
import { paths } from "../../../adapters/src/env.ts";
import type { Command } from "../registry.ts";
import { P, loadProject, upsertClip, type Project } from "../project.ts";
import { loadPlan, loadRender, savePlan } from "../plans.ts";
import { applyOps, ReviseOpSchema, type ReviseOp } from "../revise/ops.ts";
import { loadSource } from "./ingest.ts";
import { loadTranscript } from "./transcribe.ts";
import { loadVisual } from "./analyze.ts";
import { info } from "../ui.ts";

function summarizeDiff(a: EditPlan, b: EditPlan): string[] {
  const lines: string[] = [];
  const sec = (f: number) => (f / 705_600_000).toFixed(2);
  if (a.output.durationFlicks !== b.output.durationFlicks) lines.push(`duration ${sec(a.output.durationFlicks)} s → ${sec(b.output.durationFlicks)} s`);
  if (a.layoutRuns.length !== b.layoutRuns.length || JSON.stringify(a.layoutRuns.map((r) => [r.layout, r.slots.map((s) => s.cropPathId)])) !== JSON.stringify(b.layoutRuns.map((r) => [r.layout, r.slots.map((s) => s.cropPathId)]))) {
    lines.push(`layout runs: ${a.layoutRuns.length} → ${b.layoutRuns.length} (${b.layoutRuns.filter((r) => r.reason.startsWith("revision")).length} revised)`);
  }
  if (a.captions && b.captions && (a.captions.styleId !== b.captions.styleId || JSON.stringify(a.captions.chunks) !== JSON.stringify(b.captions.chunks))) {
    lines.push(`captions: ${a.captions.styleId} (${a.captions.chunks.length} chunks) → ${b.captions.styleId} (${b.captions.chunks.length} chunks)`);
  }
  if (a.audio.music.gainDb !== b.audio.music.gainDb) lines.push(`music gain ${a.audio.music.gainDb} dB → ${b.audio.music.gainDb} dB`);
  const unchanged = [
    JSON.stringify(a.segments) === JSON.stringify(b.segments) ? "segments" : null,
    JSON.stringify(a.audio.voice) === JSON.stringify(b.audio.voice) ? "voice" : null,
    JSON.stringify(a.graphics) === JSON.stringify(b.graphics) ? "graphics" : null,
  ].filter(Boolean);
  if (unchanged.length) lines.push(`preserved: ${unchanged.join(", ")}`);
  return lines;
}

export function revise(p: Project, clipId: string, ops: ReviseOp[], reason: string): { plan: EditPlan; file: string; invalidated: string[]; diff: string[] } {
  const base = loadPlan(p, clipId);
  const src = loadSource(p, base.sources[0]!.sourceId);
  const voiceSrc = base.audio.voice.sourceId;
  const transcript = loadTranscript(p, voiceSrc) ?? loadTranscript(p, src.id);
  if (!transcript) throw new Error("no transcript available for the voice source");
  const preset = loadPreset(base.presetId);
  const metrics = JSON.parse(readFileSync(join(paths().fontsDir, "metrics.json"), "utf8")) as MetricsTable;
  const { plan, invalidated } = applyOps(base, ops, {
    transcript,
    visual: loadVisual(p, src.id),
    frame: { width: src.probe.video?.displayWidth ?? 1920, height: src.probe.video?.displayHeight ?? 1080, durationFlicks: src.probe.durationFlicks },
    styleFor: (id) => loadCaptionStyle(id),
    metrics,
    zoneFor: (layout) => preset.captions.zones[layout] ?? preset.captions.zones["full-crop"] ?? { y0: 1180, y1: 1460 },
  }, reason);
  const issues = validatePlan(plan, {
    sourceFrames: new Map([[src.id, { width: src.probe.video?.displayWidth ?? 1920, height: src.probe.video?.displayHeight ?? 1080, durationFlicks: src.probe.durationFlicks }]]),
    sourceWordIds: new Set(transcript.words.map((w) => w.id)),
  });
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length) throw new Error(`revision produced an invalid plan (nothing saved):\n${errors.map((e) => `  ${e.code}: ${e.message}`).join("\n")}`);
  const file = savePlan(p, plan);
  return { plan, file, invalidated, diff: summarizeDiff(base, plan) };
}

export const reviseCommands: Record<string, Command> = {
  revise: {
    summary: "Apply typed revisions (from natural-language feedback) as a new plan version",
    usage: `shorts-studio revise <project> --clip ID --reason "<the user's words>" --op '<json>' [--op '<json>' ...]
ops: {"op":"extend-end","ms":500} {"op":"trim-end","ms":300} {"op":"extend-start","ms":400} {"op":"trim-start","ms":200}
     {"op":"keep-both-visible","from":"0:01.3","to":"0:04.3","timebase":"output"} {"op":"switch-speaker","at":"0:12"}
     {"op":"reduce-motion"} {"op":"caption-style","styleId":"clean"} {"op":"caption-emphasis","keywords":["Claude Code"],"onlyKeywords":true}
     {"op":"music-gain","db":-2} {"op":"caption-zone","from":"0:05","to":"0:09","y0":365,"y1":634,"reason":"face covered"}
     {"op":"caption-correct","from":"Artemus","to":"Artemis","at":"0:12"} {"op":"voice-chain","denoise":"off","deess":true}`,
    async run(args) {
      const p = loadProject(args.pos(0, "project"));
      const clipId = args.req("clip");
      const reason = args.req("reason");
      const ops = args.all("op").map((o, i) => {
        let raw: unknown;
        try {
          raw = JSON.parse(o);
        } catch {
          throw new Error(`--op #${i + 1} is not valid JSON: ${o}`);
        }
        const parsed = ReviseOpSchema.safeParse(raw);
        if (!parsed.success) throw new Error(`--op #${i + 1} is not a known revision: ${parsed.error.issues.map((x) => x.message).join("; ")}`);
        return parsed.data;
      });
      if (ops.length === 0) throw new Error("give at least one --op");
      const r = revise(p, clipId, ops, reason);
      info(`  invalidated stages: ${r.invalidated.join(", ") || "none"} (everything else is reused from cache)`);
      return {
        json: { clipId, version: r.plan.version, parentVersion: r.plan.parentVersion, file: r.file, invalidated: r.invalidated, changes: r.plan.changes, diff: r.diff },
        human: [`${clipId} plan v${r.plan.parentVersion} → v${r.plan.version}: ${reason}`, ...r.plan.changes.map((c) => `  • ${c.op} ${c.path}: ${c.reason}`), ...r.diff.map((d) => `  ${d}`), `  render it: shorts-studio render ${p.config.id} --clip ${clipId}`].join("\n"),
      };
    },
  },
  approve: {
    summary: "Mark a render as the approved final for a clip (never overwritten by later revisions)",
    usage: "shorts-studio approve <project> --clip ID --render rNNN",
    async run(args) {
      const p = loadProject(args.pos(0, "project"));
      const clipId = args.req("clip");
      const renderId = args.req("render");
      const rec = loadRender(p, clipId, renderId);
      if (!rec) throw new Error(`render ${renderId} not found`);
      if (rec.status !== "done") throw new Error(`render ${renderId} is ${rec.status}, not done`);
      if (rec.qaVerdict === "blocked") throw new Error(`render ${renderId} has a blocked QA verdict; fix it before approving`);
      const clip = upsertClip(p, { id: clipId, approvedRenderId: renderId });
      writeJson(join(P.clip(p, clipId), "approved.json"), { renderId, planVersion: rec.planVersion, qaVerdict: rec.qaVerdict, at: new Date().toISOString() });
      // A single creator edit also gets the stable delivery path edit/final.mp4 (versioned renders are kept).
      let final: string | null = null;
      if (clip.kind === "creator-edit" && rec.paths.video) {
        mkdirSync(P.edit(p), { recursive: true });
        final = join(P.edit(p), "final.mp4");
        copyFileSync(rec.paths.video, final);
      }
      return { json: { clipId, approvedRenderId: renderId, final }, human: `${clipId}: approved ${renderId} (plan v${rec.planVersion}, QA ${rec.qaVerdict})${final ? `\n  stable delivery path: ${final}` : ""}` };
    },
  },
};
