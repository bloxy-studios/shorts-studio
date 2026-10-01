import type { Args } from "./args.ts";
import type { SourceAsset } from "../../core/src/index.ts";
import { initProject, listProjects, loadProject, type InitOptions } from "./project.ts";
import { ingest } from "./commands/ingest.ts";
import { transcribe } from "./commands/transcribe.ts";
import { defaultSource } from "./commands/ingest.ts";
import { table } from "./ui.ts";
import { analyze, addObservation, loadCoverage } from "./commands/analyze.ts";
import { loadTranscript } from "./commands/transcribe.ts";
import { loadVisual } from "./commands/analyze.ts";
import { buildClipPlan } from "./plan/clip.ts";
import { loadCaptionStyle, loadPreset } from "../../adapters/src/presets.ts";
import { savePlan, loadPlan, loadRender, saveRender, nextPlanVersion } from "./plans.ts";
import { renderClip } from "./render/pipeline.ts";
import { runQA } from "./qa/checks.ts";
import { writeReport } from "./report.ts";
import { nextClipId, upsertClip, P } from "./project.ts";
import { QAReportSchema, readJson, writeJson as writeJsonFile } from "../../core/src/index.ts";
import { join as joinPath } from "node:path";
import { runChecks, setup } from "./commands/doctor.ts";
import { EXT_COMMANDS } from "./registry.ext.ts";

function EXT_COMMANDS_REF(): Record<string, Command> {
  return EXT_COMMANDS;
}
import { loadSource as loadSrc } from "./commands/ingest.ts";
import { parseTimecode } from "../../core/src/index.ts";

export interface CommandResult {
  json: unknown;
  human?: string;
}

export interface Command {
  summary: string;
  usage: string;
  run(args: Args): Promise<CommandResult | undefined>;
}

const PLATFORMS = ["youtube-shorts", "tiktok", "instagram-reels", "generic-9x16"] as const;

function parseBand(text: string | undefined): { minSec: number; maxSec: number } | undefined {
  if (!text) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) throw new Error(`--duration expects MIN-MAX seconds, e.g. 30-60 (got "${text}")`);
  return { minSec: Number(m[1]), maxSec: Number(m[2]) };
}

const OBS_KINDS = ["reaction", "action", "on-screen-text", "screen-demo", "gesture", "laughter", "scene", "quality-issue", "gaze", "other"] as const;

function parseRange(text: string): { start: number; end: number } {
  const m = /^\s*([^-–]+?)\s*[-–]\s*([^-–]+?)\s*$/.exec(text);
  if (!m) throw new Error(`--range expects START-END, e.g. 00:05-00:31 (got "${text}")`);
  const start = parseTimecode(m[1]!);
  const end = parseTimecode(m[2]!);
  if (end <= start) throw new Error("--range end must be after start");
  return { start, end };
}

export const COMMANDS: Record<string, Command> = {
  ...EXT_COMMANDS_REF(),
  doctor: {
    summary: "Check dependencies, models, codecs, renderer; --setup installs the local runtime",
    usage: "shorts-studio doctor [--setup] [--models yunet,whisper-base.en,whisper-small.en,whisper-small,silero-vad] [--json]",
    async run(args) {
      if (args.bool("setup")) {
        const models = args.str("models")?.split(",").map((m) => m.trim()).filter(Boolean);
        await setup({ ...(models ? { models } : {}) });
      }
      const { checks, environment } = await runChecks();
      const bad = checks.filter((c) => !c.ok && c.level === "required");
      const lines = [
        `environment: ${environment.platform}/${environment.arch} ${environment.cpu} (${environment.cores} threads, ${environment.memoryGb} GB)`,
        `runtime: ${environment.runtimeHome} (${environment.runtimeSource}); workspace: ${environment.workspace}`,
        ...checks.map((c) => `${c.ok ? "✓" : c.level === "required" ? "✗" : "○"} ${c.id.padEnd(22)} ${c.detail}${!c.ok && c.fix ? `  → ${c.fix}` : ""}`),
        bad.length ? `\n${bad.length} required item(s) missing — run: shorts-studio doctor --setup` : "\nready: all required checks pass",
      ];
      return { json: { ok: bad.length === 0, environment, checks }, human: lines.join("\n") };
    },
  },
  plan: {
    summary: "Build a validated EditPlan for a clip from a source range or candidate",
    usage: "shorts-studio plan <project> (--range START-END | --candidate ID) [--clip ID] [--preset ID] [--style ID] [--title TEXT] [--keyword TERM]... [--source ID] [--replan --reason TEXT]",
    async run(args) {
      const p = loadProject(args.pos(0, "project"));
      const sourceId = args.str("source") ?? defaultSource(p).id;
      const source = loadSrc(p, sourceId);
      const transcript = loadTranscript(p, sourceId);
      if (!transcript) throw new Error(`no transcript for ${sourceId}; run: shorts-studio transcribe ${p.config.id}`);
      const preset = loadPreset(args.str("preset") ?? p.config.presetId);
      const styleId = args.str("style") ?? p.config.captionStyleId ?? preset.captions.defaultStyleId;
      if (!preset.captions.allowedStyleIds.includes(styleId)) throw new Error(`caption style ${styleId} is not allowed by preset ${preset.id} (allowed: ${preset.captions.allowedStyleIds.join(", ")})`);
      const style = loadCaptionStyle(styleId);
      let range: { start: number; end: number };
      let candidateId: string | undefined;
      let title = args.str("title");
      if (args.str("range")) range = parseRange(args.req("range"));
      else if (args.str("candidate")) {
        const { loadCandidates } = await import("./commands/candidates.ts");
        const set = loadCandidates(p);
        const c = set?.candidates.find((x: { id: string }) => x.id === args.str("candidate"));
        if (!c) throw new Error(`unknown candidate ${args.str("candidate")}`);
        range = { start: c.start, end: c.end };
        candidateId = c.id;
        title = title ?? c.title;
      } else throw new Error("give --range START-END or --candidate ID");
      const clipId = args.str("clip") ?? nextClipId(p);
      const existingVersions = nextPlanVersion(p, clipId) - 1;
      if (existingVersions > 0 && !args.bool("replan")) throw new Error(`clip ${clipId} already has a plan; use \`shorts-studio revise\` to change it, or --replan to rebuild it as a new version`);
      const { plan, notes } = buildClipPlan({
        projectId: p.config.id,
        clipId,
        source,
        transcript,
        visual: loadVisual(p, sourceId),
        preset,
        style,
        range,
        ...(candidateId ? { candidateId } : {}),
        ...(title ? { title } : {}),
        keywords: args.all("keyword"),
        speech: (await import("./commands/analyze.ts")).loadAudioFeatures(p, sourceId)?.speech ?? [],
        decisions: [
          { key: "preset", value: preset.id, layer: args.str("preset") ? "user" : "project", reason: args.str("preset") ? "requested" : "project preset" },
          { key: "captionStyle", value: style.id, layer: args.str("style") ? "user" : p.config.captionStyleId ? "project" : "preset", reason: "caption style selection" },
        ],
      });
      upsertClip(p, { id: clipId, ...(title ? { title } : {}), kind: "clip" });
      if (existingVersions > 0) {
        plan.version = existingVersions + 1;
        plan.parentVersion = existingVersions;
        plan.changeSummary = `re-planned from scratch (v${existingVersions} kept)`;
        plan.changes = [{ path: "*", op: "replan", reason: args.str("reason") ?? "planner rebuilt the clip from its source range" }];
      }
      const file = savePlan(p, plan);
      writeJsonFile(joinPath(P.plans(p, clipId), `planner-notes-v${String(plan.version).padStart(3, "0")}.json`), { notes });
      return {
        json: { clipId, version: plan.version, file, durationSec: plan.output.durationFlicks / 705_600_000, frames: plan.output.frameCount, segments: plan.segments.length, runs: plan.layoutRuns.length, captionChunks: plan.captions?.chunks.length ?? 0, notes },
        human: [`${clipId} plan v${plan.version}: ${(plan.output.durationFlicks / 705_600_000).toFixed(2)} s, ${plan.segments.length} segment(s), ${plan.layoutRuns.length} layout run(s), ${plan.captions?.chunks.length ?? 0} caption chunks`, `  ${file}`, ...notes.map((n) => `  • ${n}`)].join("\n"),
      };
    },
  },
  render: {
    summary: "Render a clip from its current EditPlan, then run measured QA and write the report",
    usage: "shorts-studio render <project> --clip ID [--draft] [--plan-version N] [--platform youtube-shorts|tiktok|instagram-reels|generic-9x16]",
    async run(args) {
      const p = loadProject(args.pos(0, "project"));
      const clipId = args.req("clip");
      const out = await renderClip(p, clipId, { draft: args.bool("draft"), ...(args.num("plan-version") ? { planVersion: args.num("plan-version")! } : {}) });
      const platform = args.str("platform") ?? p.config.platforms[0];
      const qa = await runQA({ p, plan: out.plan, record: out.record, captions: out.captions, sources: out.sources, dir: out.dir, luxury: out.luxury, ...(platform ? { platform } : {}) });
      const paths: Record<string, string> = { ...out.record.paths, qa: joinPath(out.dir, "qa.json") };
      const record = { ...out.record, qaVerdict: qa.summary.verdict, paths };
      const firstSource = [...out.sources.keys()][0]!;
      const notesFile = joinPath(P.plans(p, clipId), `planner-notes-v${String(out.plan.version).padStart(3, "0")}.json`);
      let planNotes: string[] = [];
      try {
        planNotes = (JSON.parse(await Bun.file(notesFile).text()) as { notes: string[] }).notes;
      } catch {
        planNotes = [];
      }
      const reportPath = writeReport({ plan: out.plan, record, qa, sources: out.sources, transcript: loadTranscript(p, firstSource), coverage: loadCoverage(p, firstSource), captions: out.captions, dir: out.dir, planNotes });
      record.paths.report = reportPath;
      saveRender(p, record);
      const lines = [
        `render ${clipId}/${record.id}: QA ${qa.summary.verdict} (${qa.summary.passed} pass, ${qa.summary.warnings} warn, ${qa.summary.hardFailures} hard fail)`,
        ...qa.findings.filter((f) => f.status !== "pass").map((f) => `  [${f.status}] ${f.check}: ${f.message}`),
        `  video:  ${record.paths.video}`,
        `  report: ${reportPath}`,
        ...qa.inspection.filter((i) => i.artifact).map((i) => `  inspect: ${i.artifact}`),
      ];
      return { json: { clipId, renderId: record.id, verdict: qa.summary.verdict, paths: record.paths, findings: qa.findings.map((f) => ({ check: f.check, status: f.status, severity: f.severity, message: f.message })) }, human: lines.join("\n") };
    },
  },
  qa: {
    summary: "Re-run QA on a render, or record a visual inspection (`qa note`)",
    usage: `shorts-studio qa <project> --clip ID [--render rNNN]
shorts-studio qa note <project> --clip ID --render rNNN --what TEXT --notes TEXT [--how agent-visual|human|agent-audio-measure]`,
    async run(args) {
      if (args.positionals[0] === "note") {
        const p = loadProject(args.pos(1, "project"));
        const clipId = args.req("clip");
        const renderId = args.req("render");
        const file = joinPath(P.render(p, clipId, renderId), "qa.json");
        const qa = readJson(file, QAReportSchema);
        const how = (args.str("how") ?? "agent-visual") as "agent-visual" | "human" | "agent-audio-measure";
        const what = args.req("what");
        const inspection = [...qa.inspection.filter((i) => !(i.how === "not-performed" && i.artifact && what.includes(i.artifact.split("/").pop()!))), { what, how, notes: args.req("notes") }];
        writeJsonFile(file, { ...qa, inspection });
        // The report reflects recorded inspections (no "visual review pending" once it is done).
        const record = loadRender(p, clipId, renderId);
        if (record?.paths.report) {
          const plan = loadPlan(p, clipId, record.planVersion);
          const sources = new Map(plan.sources.map((s) => [s.sourceId, loadSrc(p, s.sourceId)]));
          const firstSource = [...sources.keys()][0]!;
          const { renderCaptions } = await import("./render/pipeline.ts");
          writeReport({ plan, record, qa: { ...qa, inspection }, sources, transcript: loadTranscript(p, firstSource), coverage: loadCoverage(p, firstSource), captions: await renderCaptions(p, plan), dir: P.render(p, clipId, renderId) });
        }
        return { json: { recorded: true }, human: `inspection recorded for ${clipId}/${renderId}` };
      }
      const p = loadProject(args.pos(0, "project"));
      const clipId = args.req("clip");
      const clip = p.config.clips.find((c) => c.id === clipId);
      const renderId = args.str("render") ?? clip?.latestRenderId;
      if (!renderId) throw new Error(`clip ${clipId} has no render`);
      const record = loadRender(p, clipId, renderId);
      if (!record) throw new Error(`render ${renderId} not found`);
      const plan = loadPlan(p, clipId, record.planVersion);
      const sources = new Map(plan.sources.map((s) => [s.sourceId, loadSrc(p, s.sourceId)]));
      // Reuse the render's cached caption band and Luxury matte QA so no check silently drops out.
      const { renderCaptions } = await import("./render/pipeline.ts");
      const { cachedLuxuryLayers } = await import("./luxury/render.ts");
      const captions = await renderCaptions(p, plan);
      const dir = P.render(p, clipId, renderId);
      const qa = await runQA({ p, plan, record, captions, sources, dir, luxury: cachedLuxuryLayers(p, plan, sources) });
      // Keep the record and report consistent with the new measurements.
      const updated = { ...record, qaVerdict: qa.summary.verdict, paths: { ...record.paths, qa: joinPath(dir, "qa.json") } as Record<string, string> };
      const firstSource = [...sources.keys()][0]!;
      updated.paths.report = writeReport({ plan, record: updated, qa, sources, transcript: loadTranscript(p, firstSource), coverage: loadCoverage(p, firstSource), captions, dir });
      saveRender(p, updated);
      return { json: qa, human: `QA ${qa.summary.verdict}: ${qa.findings.map((f) => `${f.check}=${f.status}`).join(", ")}` };
    },
  },
  analyze: {
    summary: "Scenes, audio features, face tracks, timestamped frame sheets; `note` records agent observations",
    usage: `shorts-studio analyze <project> [--source ID] [--face-fps N] [--tiles N] [--force]
shorts-studio analyze note <project> --kind reaction|action|on-screen-text|screen-demo|gesture|laughter|scene|quality-issue|gaze|other --at TIME [--end TIME] --detail TEXT [--confidence 0-1] [--sheet ID] [--source ID]`,
    async run(args) {
      if (args.positionals[0] === "note") {
        const p = loadProject(args.pos(1, "project"));
        const sourceId = args.str("source") ?? defaultSource(p).id;
        const kind = args.req("kind");
        if (!(OBS_KINDS as readonly string[]).includes(kind)) throw new Error(`--kind must be one of ${OBS_KINDS.join(", ")}`);
        const v = addObservation(p, sourceId, {
          kind: kind as (typeof OBS_KINDS)[number],
          t: parseTimecode(args.req("at")),
          ...(args.str("end") ? { end: parseTimecode(args.str("end")!) } : {}),
          detail: args.req("detail"),
          confidence: args.num("confidence", 0.7)!,
          ...(args.str("sheet") ? { sheetId: args.str("sheet")! } : {}),
        });
        return { json: { observations: v.observations.length }, human: `recorded observation #${v.observations.length} for ${sourceId}` };
      }
      const p = loadProject(args.pos(0, "project"));
      const sourceId = args.str("source") ?? defaultSource(p).id;
      const r = await analyze(p, { sourceId, ...(args.num("face-fps") ? { faceFps: args.num("face-fps")! } : {}), ...(args.num("tiles") ? { overviewTiles: args.num("tiles")! } : {}), force: args.bool("force") });
      const sheets = r.visual?.frameSheets.map((s) => s.path) ?? [];
      return {
        json: { sourceId, coverage: r.coverage, scenes: r.visual?.scenes.length ?? 0, faceTracks: r.visual?.faceTracks.length ?? 0, speakerLinks: r.visual?.speakerLinks ?? [], sheets, audio: r.audio ? { speechRegions: r.audio.speech.length, events: r.audio.events.length, integratedLufs: r.audio.loudness.integratedLufs } : null },
        human: [`coverage: transcript=${r.coverage.transcript} visual=${r.coverage.visual} audio=${r.coverage.audio}`, `scenes=${r.visual?.scenes.length ?? 0} faceTracks=${r.visual?.faceTracks.length ?? 0}`, "sheets to inspect:", ...sheets.map((s) => `  ${s}`), ...r.coverage.limitations.map((l) => `limitation: ${l}`)].join("\n"),
      };
    },
  },
  project: {
    summary: "Create, list or show projects (init <name> | list | show <project>)",
    usage: `shorts-studio project init <name> [--preset ID] [--mode guided|director|autonomous] [--platform P]... [--clips N] [--duration 30-60] [--language en|sw|auto] [--dir PATH]
shorts-studio project list
shorts-studio project show <project>`,
    async run(args) {
      const sub = args.pos(0, "init|list|show");
      if (sub === "list") {
        const ids = listProjects();
        return { json: { projects: ids }, human: ids.length ? ids.join("\n") : "(no projects in this workspace)" };
      }
      if (sub === "show") {
        const p = loadProject(args.pos(1, "project"));
        return { json: { dir: p.dir, config: p.config }, human: JSON.stringify({ dir: p.dir, ...p.config }, null, 2) };
      }
      if (sub === "init") {
        const name = args.pos(1, "name");
        const platforms = args.all("platform");
        for (const pl of platforms) if (!(PLATFORMS as readonly string[]).includes(pl)) throw new Error(`unknown platform ${pl}; use ${PLATFORMS.join(", ")}`);
        const opts: InitOptions = {
          ...(args.str("preset") ? { preset: args.str("preset")! } : {}),
          ...(args.str("mode") ? { mode: args.str("mode") as InitOptions["mode"] } : {}),
          ...(platforms.length ? { platforms: platforms as InitOptions["platforms"] } : {}),
          ...(args.num("clips") ? { clipCount: args.num("clips")! } : {}),
          ...(parseBand(args.str("duration")) ? { durationBand: parseBand(args.str("duration"))! } : {}),
          ...(args.str("language") ? { language: args.str("language")! } : {}),
          ...(args.str("dir") ? { dir: args.str("dir")! } : {}),
        };
        const p = initProject(name, opts);
        return { json: { dir: p.dir, id: p.config.id }, human: `project ${p.config.id} at ${p.dir}` };
      }
      throw new Error(`unknown project subcommand ${sub}`);
    },
  },
  ingest: {
    summary: "Acquire/probe sources: local files, folders, manifests, YouTube URLs",
    usage: "shorts-studio ingest <project> <file|folder|manifest.json|url>... [--role primary|camera|mic|screen|broll] [--force]",
    async run(args) {
      const p = loadProject(args.pos(0, "project"));
      const inputs = args.positionals.slice(1);
      if (inputs.length === 0) throw new Error("give at least one file, folder, manifest or URL");
      const role = args.str("role") as SourceAsset["role"] | undefined;
      const assets = await ingest(p, inputs, { ...(role ? { role } : {}), force: args.bool("force") });
      const rows = assets.map((a) => ({
        id: a.id,
        role: a.role,
        seconds: (a.probe.durationFlicks / 705_600_000).toFixed(2),
        video: a.probe.video ? `${a.probe.video.displayWidth}x${a.probe.video.displayHeight}@${(a.probe.video.fps.num / a.probe.video.fps.den).toFixed(2)}${a.probe.video.isVFR ? " VFR" : ""}` : "-",
        audio: a.probe.audio[0] ? `${a.probe.audio[0].channels}ch ${a.probe.audio[0].sampleRate}Hz` : "-",
        source: a.provenance.attribution.slice(0, 60),
      }));
      return { json: { sources: assets.map((a) => ({ id: a.id, role: a.role, localPath: a.localPath, probe: a.probe, provenance: a.provenance })) }, human: table(rows) };
    },
  },
  transcribe: {
    summary: "Local whisper.cpp transcription with word timings (language-aware)",
    usage: "shorts-studio transcribe <project> [--source ID] [--model base.en|small|...] [--language en|sw|auto] [--force]",
    async run(args) {
      const p = loadProject(args.pos(0, "project"));
      const sourceId = args.str("source") ?? defaultSource(p).id;
      const t = await transcribe(p, {
        sourceId,
        ...(args.str("model") ? { model: args.str("model")! } : {}),
        ...(args.str("language") ? { language: args.str("language")! } : {}),
        force: args.bool("force"),
      });
      return {
        json: { sourceId, language: t.language, words: t.words.length, segments: t.segments.length, engine: t.engine },
        human: `${sourceId}: ${t.words.length} words in ${t.segments.length} segments (${t.engine.name} ${t.engine.model}, language ${t.language})`,
      };
    },
  },
};
