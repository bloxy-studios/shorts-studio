/**
 * Lightweight local review page (spec §21): candidates with timestamps and evidence,
 * caption A/B sheets, layout/graphics previews, draft/final renders with QA and reports.
 * One static HTML file with relative links into the project — nothing is uploaded.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CandidateSetSchema, flicksToSeconds, formatTimecode, readJson, type EditPlan, type QAReport } from "../../../core/src/index.ts";
import type { Command } from "../registry.ts";
import { P, loadProject, nowIso, type Project } from "../project.ts";
import { loadPlan, loadRender } from "../plans.ts";
import { loadSource } from "./ingest.ts";

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function rel(p: Project, file: string): string {
  return relative(P.review(p), file).split("/").map(encodeURIComponent).join("/");
}

function images(dir: string, match: (f: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, f.name);
    if (f.isDirectory()) out.push(...images(full, match));
    else if (match(f.name)) out.push(full);
  }
  return out.sort();
}

function verdictBadge(v: string | null | undefined): string {
  const cls = v === "pass" ? "ok" : v === "pass-with-warnings" ? "warn" : v ? "bad" : "none";
  return `<span class="badge ${cls}">${esc(v ?? "no QA")}</span>`;
}

function candidatesSection(p: Project): string {
  const file = P.candidates(p);
  if (!existsSync(file)) return "";
  const set = readJson(file, CandidateSetSchema);
  const cards = [...set.candidates]
    .sort((a, b) => b.scores.total - a.scores.total)
    .map((c, i) => {
      const crit = Object.entries(c.scores.criteria)
        .map(([k, v]) => `<div class="crit"><span>${esc(k)}</span><i style="width:${Math.round(v * 100)}%"></i></div>`)
        .join("");
      const fallback = join(P.analysis(p, "previews"), "..", "previews", `${c.id}.jpg`);
      const sheet = c.preview?.contactSheet ?? c.preview?.path.replace(/\.mp4$/, ".jpg") ?? (existsSync(fallback) ? fallback : undefined);
      const clipFile = c.preview?.path ?? (existsSync(fallback.replace(/\.jpg$/, ".mp4")) ? fallback.replace(/\.jpg$/, ".mp4") : undefined);
      const preview = sheet && existsSync(sheet) ? `<img loading="lazy" src="${rel(p, sheet)}" alt="preview sheet for ${esc(c.title)}"/>` : "";
      return `<article class="card"><header><b>#${i + 1}</b> ${esc(c.title)} <span class="badge ${c.selection.state === "selected" ? "ok" : c.selection.state === "rejected" ? "bad" : "none"}">${esc(c.selection.state)}</span></header>
<p class="meta">${esc(c.id)} · ${formatTimecode(c.start)}–${formatTimecode(c.end)} (${flicksToSeconds(c.end - c.start).toFixed(1)} s) · score ${c.scores.total.toFixed(1)} · ${esc(c.analysisLevel)}</p>
<p class="hook">“${esc(c.hook)}”</p>${crit}
<ul>${c.evidence.slice(0, 4).map((e) => `<li>${esc((e as { detail?: string; kind?: string }).detail ?? JSON.stringify(e))}</li>`).join("")}</ul>
${c.reasonsNotToUse.length ? `<p class="meta">Not to use: ${esc(c.reasonsNotToUse.join("; "))}</p>` : ""}${preview}${clipFile ? `<p><a href="${rel(p, clipFile)}">preview clip</a></p>` : ""}</article>`;
    })
    .join("\n");
  return `<section><h2>Candidate moments</h2><p class="meta">Scores are editorial potential with evidence, not virality predictions. Requested ${set.requested.count} × ${set.requested.minSec}–${set.requested.maxSec} s.</p><div class="grid">${cards}</div></section>`;
}

function clipSection(p: Project, clipId: string): string {
  let plan: EditPlan | null = null;
  try {
    plan = loadPlan(p, clipId);
  } catch {
    return "";
  }
  const clip = p.config.clips.find((c) => c.id === clipId);
  const runs = plan.layoutRuns
    .map((r) => `<tr><td>${esc(r.id)}</td><td>${flicksToSeconds(r.outStart).toFixed(2)}–${flicksToSeconds(r.outEnd).toFixed(2)}</td><td>${esc(r.layout)}</td><td>${esc(plan!.graphics.find((g) => g.id === r.graphicId)?.subject ?? "")}</td><td>${r.captionZone.y0}–${r.captionZone.y1}</td><td>${esc(r.exceptions.join("; "))}</td></tr>`)
    .join("");
  const renderDirs = existsSync(P.renders(p, clipId)) ? readdirSync(P.renders(p, clipId)).filter((d) => /^r\d+$/.test(d)).sort().reverse() : [];
  const renders = renderDirs
    .map((id) => {
      const rec = loadRender(p, clipId, id);
      if (!rec) return "";
      const dir = P.render(p, clipId, id);
      const qaFile = join(dir, "qa.json");
      const qa = existsSync(qaFile) ? (JSON.parse(readFileSync(qaFile, "utf8")) as QAReport) : null;
      const open = qa?.findings.filter((f) => f.status === "fail" || f.status === "warn") ?? [];
      const sheets = ["qa/contact.jpg", "qa/cuts.jpg"].map((s) => join(dir, s)).filter(existsSync);
      return `<article class="render"><header><b>${esc(id)}</b> · plan v${rec.planVersion} · ${esc(rec.kind)} · ${verdictBadge(rec.qaVerdict)}${clip?.approvedRenderId === id ? ' <span class="badge ok">approved</span>' : ""}</header>
${rec.paths.preview && existsSync(rec.paths.preview) ? `<video controls preload="none" ${rec.paths.cover ? `poster="${rel(p, rec.paths.cover)}"` : ""} src="${rel(p, rec.paths.preview)}"></video>` : ""}
<p>${rec.paths.video ? `<a href="${rel(p, rec.paths.video)}">final MP4</a>` : ""} ${rec.paths.report ? `· <a href="${rel(p, rec.paths.report)}">report</a>` : ""} ${existsSync(qaFile) ? `· <a href="${rel(p, qaFile)}">qa.json</a>` : ""}</p>
${open.length ? `<ul class="findings">${open.map((f) => `<li class="${f.status}">${esc(f.check)} (${esc(f.severity)} ${esc(f.status)}): ${esc(f.message)}</li>`).join("")}</ul>` : ""}
${sheets.map((s) => `<a href="${rel(p, s)}"><img loading="lazy" class="sheet" src="${rel(p, s)}" alt="QA sheet"/></a>`).join("")}</article>`;
    })
    .join("\n");
  const luxury = images(join(P.review(p), "luxury"), (f) => f === "contact-sheet.jpg").filter((f) => f.includes(`${clipId}-v`));
  const latestLux = luxury.filter((f) => f.includes(`${clipId}-v${plan!.version}/`) || f.includes(`${clipId}-v`)).slice(-6);
  const brief = join(P.brief(p), clipId, "DIRECTOR_BRIEF.md");
  const layoutMd = join(P.clip(p, clipId), "luxury", "layout-runs.md");
  return `<section><h2>Clip ${esc(clipId)} <span class="meta">plan v${plan.version} (${esc(plan.presetId)}) · ${flicksToSeconds(plan.output.durationFlicks).toFixed(2)} s @ ${Number((plan.output.fps.num / plan.output.fps.den).toFixed(3))} fps</span></h2>
<p>${existsSync(brief) ? `<a href="${rel(p, brief)}">DIRECTOR_BRIEF</a>` : ""} ${existsSync(layoutMd) ? `· <a href="${rel(p, layoutMd)}">layout runs</a>` : ""}</p>
<table><thead><tr><th>Run</th><th>Time (s)</th><th>Layout</th><th>Graphic</th><th>Captions y</th><th>Exceptions</th></tr></thead><tbody>${runs}</tbody></table>
${latestLux.length ? `<h3>Graphics previews</h3><div class="strip">${latestLux.map((f) => `<a href="${rel(p, f)}"><img loading="lazy" src="${rel(p, f)}" alt="graphics preview"/></a>`).join("")}</div>` : ""}
<h3>Renders</h3>${renders || '<p class="meta">not rendered yet</p>'}</section>`;
}

export function writeReviewPage(p: Project): string {
  const sources = p.config.sources.map((id) => {
    try {
      const s = loadSource(p, id);
      return `<li><b>${esc(id)}</b> ${esc(s.role)} · ${flicksToSeconds(s.probe.durationFlicks).toFixed(1)} s${s.probe.video ? ` · ${s.probe.video.displayWidth}×${s.probe.video.displayHeight} @ ${(s.probe.video.fps.num / s.probe.video.fps.den).toFixed(2)} fps${s.probe.video.isHDR ? ` · HDR ${esc(s.probe.video.hdrKind)}` : ""}` : " · audio"} · ${esc(s.kind)}: ${esc(s.input)}</li>`;
    } catch {
      return `<li>${esc(id)} (missing)</li>`;
    }
  });
  const captionSheets = images(join(P.review(p), "captions"), (f) => f === "caption-styles.jpg");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Shorts Studio review — ${esc(p.config.name)}</title>
<style>
:root{--ink:#16161a;--muted:#6b6b73;--line:#e6e6e2;--ok:#1e8e3e;--warn:#b26a00;--bad:#c5221f;--bg:#f6f6f3}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
main{max-width:1240px;margin:0 auto;padding:32px 24px 80px}h1{font-size:28px;margin:0 0 4px}h2{font-size:21px;margin:40px 0 12px;border-top:1px solid var(--line);padding-top:24px}h3{font-size:16px;margin:20px 0 8px}
.meta{color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
.card,.render{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:16px}.card header,.render header{font-weight:600;margin-bottom:6px}
.card img,.strip img,.sheet{width:100%;border-radius:8px;border:1px solid var(--line);margin-top:8px}.strip{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.hook{font-style:italic}.crit{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}.crit span{width:80px}.crit i{display:block;height:6px;border-radius:3px;background:#d97757}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;background:#eee;color:var(--muted)}.badge.ok{background:#e6f4ea;color:var(--ok)}.badge.warn{background:#fef3e0;color:var(--warn)}.badge.bad{background:#fce8e6;color:var(--bad)}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}
video{width:270px;border-radius:10px;background:#000;display:block;margin:8px 0}.findings li.fail{color:var(--bad)}.findings li.warn{color:var(--warn)}a{color:#9a4a2a}
</style></head><body><main>
<h1>${esc(p.config.name)}</h1><p class="meta">${esc(p.config.id)} · preset ${esc(p.config.presetId)} · ${esc(p.config.mode)} mode · ${esc(p.config.platforms.join(", "))} · generated ${esc(nowIso())} · local file, nothing uploaded</p>
<section><h2>Sources</h2><ul>${sources.join("")}</ul></section>
${candidatesSection(p)}
${captionSheets.length ? `<section><h2>Caption previews (same footage, A/B)</h2><div class="strip">${captionSheets.map((f) => `<a href="${rel(p, f)}"><img loading="lazy" src="${rel(p, f)}" alt="caption style comparison"/></a>`).join("")}</div></section>` : ""}
${p.config.clips.map((c) => clipSection(p, c.id)).join("\n")}
</main></body></html>
`;
  const out = join(P.review(p), "index.html");
  writeFileSync(out, html);
  return out;
}

export const reviewCommands: Record<string, Command> = {
  review: {
    summary: "Generate the local HTML review page (candidates + evidence, caption A/B sheets, layout/graphics previews, renders with QA and reports)",
    usage: "shorts-studio review <project>",
    async run(args) {
      const p = loadProject(args.pos(0, "project"));
      const out = writeReviewPage(p);
      return { json: { page: out }, human: `review page: ${out}\n(open it in a browser: open "${out}")` };
    },
  },
};
