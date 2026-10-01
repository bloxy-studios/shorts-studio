import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { flicksToSeconds, formatTimecode, writeJson, type EditPlan, type RenderRecord } from "../../../core/src/index.ts";
import { assertWritableOutput } from "../../../adapters/src/env.ts";
import type { Command } from "../registry.ts";
import { P, loadProject, nowIso, type Project } from "../project.ts";
import { loadPlan, loadRender } from "../plans.ts";
import { loadSource } from "./ingest.ts";
import { loadCandidates } from "./candidates.ts";
import { info, stage, warn } from "../ui.ts";

interface PackagedFile {
  role: string;
  path: string;
  bytes: number;
  sha256: string;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function copyInto(dir: string, src: string, name: string, role: string, files: PackagedFile[]): void {
  if (!existsSync(src)) return;
  const dest = join(dir, name);
  cpSync(src, dest, { recursive: statSync(src).isDirectory() });
  if (statSync(dest).isFile()) files.push({ role, path: dest, bytes: statSync(dest).size, sha256: sha256(dest) });
  else for (const f of readdirSync(dest)) if (statSync(join(dest, f)).isFile()) files.push({ role, path: join(dest, f), bytes: statSync(join(dest, f)).size, sha256: sha256(join(dest, f)) });
}

/** Original ↔ final timing table for editors (segments and word anchors). */
function timingMap(plan: EditPlan): unknown {
  return {
    output: { durationMs: flicksToSeconds(plan.output.durationFlicks) * 1000, frames: plan.output.frameCount, fps: `${plan.output.fps.num}/${plan.output.fps.den}` },
    segments: plan.segments.map((s) => ({
      id: s.id,
      output: [formatTimecode(s.picture.outStart), formatTimecode(s.picture.outEnd)],
      source: [formatTimecode(s.picture.srcStart), formatTimecode(s.picture.srcStart + s.picture.outEnd - s.picture.outStart)],
      sourceId: s.picture.sourceId,
      audio: s.audio.map((a) => ({ sourceId: a.sourceId, output: [formatTimecode(a.outStart), formatTimecode(a.outEnd)], source: [formatTimecode(a.srcStart), formatTimecode(a.srcStart + a.outEnd - a.outStart)] })),
    })),
  };
}

/** Recursive copy of an editable composition (sources + assets; rendered media and snapshots excluded). */
function copyTree(src: string, dest: string, files: PackagedFile[]): void {
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(src)) {
    const s = join(src, f);
    if (statSync(s).isDirectory()) {
      if (f !== "shots" && f !== "frames") copyTree(s, join(dest, f), files);
      continue;
    }
    if (/\.(mp4|mov|webm)$/i.test(f)) continue;
    copyFileSync(s, join(dest, f));
    files.push({ role: "hyperframes-source", path: join(dest, f), bytes: statSync(s).size, sha256: sha256(join(dest, f)) });
  }
}

/** Honest, source-grounded post copy draft (Claude refines it; never claims reach or virality). */
function postCopy(p: Project, plan: EditPlan): string {
  const cand = loadCandidates(p)?.candidates.find((c) => c.id === plan.candidateId);
  const src = loadSource(p, plan.sources[0]!.sourceId);
  const words = plan.captions?.chunks.flatMap((c) => c.words.map((w) => w.display)) ?? [];
  const firstLine = words.slice(0, 14).join(" ");
  const keywords = ((plan.captions?.overrides as { keywords?: string[] } | undefined)?.keywords ?? []).map((k) => `#${k.replace(/[^A-Za-z0-9]/g, "")}`);
  const titles = [cand?.title, plan.cover?.title, cand ? `"${cand.hook.slice(0, 80)}"` : null].filter((x): x is string => Boolean(x));
  return [
    `# Post copy draft — ${plan.clipId}`,
    "",
    "Draft generated from the actual words in the clip. Edit before posting; nothing is published automatically.",
    "",
    "## Title / hook options (truthful to the speech)",
    ...[...new Set(titles)].map((t) => `- ${t}`),
    "",
    "## Caption",
    `${firstLine}${words.length > 14 ? "…" : ""}`,
    "",
    `Source: ${src.provenance.attribution}${src.provenance.license ? ` (license: ${src.provenance.license})` : ""}`,
    "",
    "## Hashtags (only if relevant to your audience)",
    keywords.length ? keywords.join(" ") : "_(add 2–4 specific tags; avoid generic reach-bait)_",
  ].join("\n");
}

export interface ExportOptions {
  clips?: string[];
  approvedOnly: boolean;
  dest: string;
  includeStems: boolean;
  postCopy: boolean;
}

export function exportProject(p: Project, opts: ExportOptions): { dir: string; packages: Array<{ clipId: string; renderId: string; files: PackagedFile[] }>; skipped: string[] } {
  const stamp = nowIso().slice(0, 10);
  const root = opts.dest.startsWith("local:") && opts.dest !== "local:default" ? resolve(opts.dest.slice(6)) : join(P.exports(p), `${stamp}-${p.config.id}`);
  if (opts.dest.startsWith("drive:")) {
    throw new Error("Google Drive delivery needs a connected Drive tool or OAuth configuration in this session; none is configured. Export locally (default) and upload with your Drive connector, or configure one and retry. Raw footage is never uploaded.");
  }
  assertWritableOutput(root);
  mkdirSync(root, { recursive: true });
  const packages: Array<{ clipId: string; renderId: string; files: PackagedFile[] }> = [];
  const skipped: string[] = [];
  const clips = p.config.clips.filter((c) => !opts.clips || opts.clips.includes(c.id));
  for (const clip of clips) {
    const renderId = clip.approvedRenderId ?? (opts.approvedOnly ? null : clip.latestRenderId);
    if (!renderId) {
      skipped.push(`${clip.id}: ${opts.approvedOnly ? "no approved render" : "not rendered"}`);
      continue;
    }
    const rec: RenderRecord | null = loadRender(p, clip.id, renderId);
    if (!rec || rec.status !== "done") {
      skipped.push(`${clip.id}: render ${renderId} is not complete`);
      continue;
    }
    if (rec.qaVerdict === "blocked") {
      skipped.push(`${clip.id}: render ${renderId} is QA-blocked (deliver as draft only on explicit request)`);
      continue;
    }
    const plan = loadPlan(p, clip.id, rec.planVersion);
    const dir = join(root, clip.id);
    mkdirSync(dir, { recursive: true });
    stage("export", `${clip.id} ← ${renderId} (plan v${rec.planVersion}, QA ${rec.qaVerdict}${clip.approvedRenderId === renderId ? ", approved" : ""})`);
    const files: PackagedFile[] = [];
    const base = `${p.config.id}_${clip.id}_v${rec.planVersion}`;
    const rdir = P.render(p, clip.id, renderId);
    copyInto(dir, rec.paths.video!, `${base}.mp4`, "final", files);
    if (rec.paths.preview) copyInto(dir, rec.paths.preview, `${base}_preview.mp4`, "preview", files);
    if (rec.paths.cover) copyInto(dir, rec.paths.cover, `${base}_cover.jpg`, "cover", files);
    for (const [k, ext] of [["srt", "srt"], ["vtt", "vtt"], ["wordsJson", "words.json"]] as const) if (rec.paths[k]) copyInto(dir, rec.paths[k]!, `${base}.${ext}`, "subtitles", files);
    copyInto(dir, join(rdir, "editplan.json"), "editplan.json", "plan", files);
    writeJson(join(dir, "timing-map.json"), timingMap(plan));
    files.push({ role: "plan", path: join(dir, "timing-map.json"), bytes: statSync(join(dir, "timing-map.json")).size, sha256: sha256(join(dir, "timing-map.json")) });
    copyInto(dir, join(rdir, "report.md"), "report.md", "report", files);
    copyInto(dir, join(rdir, "qa.json"), "qa.json", "report", files);
    copyInto(dir, join(rdir, "qa"), "contact-sheets", "contact-sheet", files);
    if (opts.includeStems && existsSync(join(rdir, "stems"))) copyInto(dir, join(rdir, "stems"), "stems", "stem", files);
    // Editable HyperFrames sources used by this render (captions + graphics compositions).
    const capCache = join(P.clip(p, clip.id), "cache", "captions");
    if (existsSync(capCache)) {
      const comps = readdirSync(capCache).filter((d) => existsSync(join(capCache, d, "composition", "index.html")));
      for (const d of comps) copyInto(join(dir, "hyperframes", `captions-${d.slice(0, 8)}`), join(capCache, d, "composition"), ".", "hyperframes-source", files);
    }
    for (const [key, src] of Object.entries(rec.paths)) {
      if (!key.startsWith("hf_") || !existsSync(src)) continue;
      copyTree(src, join(dir, "hyperframes", key.slice(3)), files);
    }
    if (opts.postCopy) {
      writeFileSync(join(dir, "post.md"), postCopy(p, plan));
      files.push({ role: "post-copy", path: join(dir, "post.md"), bytes: statSync(join(dir, "post.md")).size, sha256: sha256(join(dir, "post.md")) });
    }
    writeJson(join(dir, "manifest.json"), {
      project: p.config.id,
      clip: clip.id,
      render: renderId,
      planVersion: rec.planVersion,
      qaVerdict: rec.qaVerdict,
      approved: clip.approvedRenderId === renderId,
      destination: { kind: "local", path: dir, uploaded: [] },
      files: files.map((f) => ({ ...f, path: f.path.slice(dir.length + 1) })),
      createdAt: nowIso(),
    });
    packages.push({ clipId: clip.id, renderId, files });
  }
  writeJson(join(root, "export.json"), { project: p.config.id, packages: packages.map((x) => ({ clip: x.clipId, render: x.renderId, files: x.files.length })), skipped, localOnly: true, createdAt: nowIso() });
  for (const s of skipped) warn(`skipped ${s}`);
  info(`  ✓ ${packages.length} package(s) in ${root}`);
  return { dir: root, packages, skipped };
}

export const exportCommands: Record<string, Command> = {
  export: {
    summary: "Package final clips (MP4, preview, cover, subtitles, plan, stems, sources, report) for delivery",
    usage: "shorts-studio export <project> [--clips clip-01,clip-02] [--approved-only] [--dest local:DIR | drive:FOLDER] [--stems] [--post-copy]",
    async run(args) {
      const p = loadProject(args.pos(0, "project"));
      const res = exportProject(p, {
        ...(args.str("clips") ? { clips: args.str("clips")!.split(",").map((s) => s.trim()) } : {}),
        approvedOnly: args.bool("approved-only"),
        dest: args.str("dest") ?? "local:default",
        includeStems: args.bool("stems", true),
        postCopy: args.bool("post-copy", true),
      });
      return {
        json: { dir: res.dir, packages: res.packages.map((x) => ({ clipId: x.clipId, renderId: x.renderId, files: x.files.map((f) => ({ role: f.role, path: f.path, bytes: f.bytes })) })), skipped: res.skipped },
        human: [`export: ${res.dir}`, ...res.packages.map((x) => `  ${x.clipId} (${x.renderId}): ${x.files.length} files — ${x.files.filter((f) => f.role === "final").map((f) => basename(f.path)).join(", ")}`), ...res.skipped.map((s) => `  skipped: ${s}`), "  (local only — nothing was uploaded or posted)"].join("\n"),
      };
    },
  },
};
