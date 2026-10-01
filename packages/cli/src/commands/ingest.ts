import { existsSync, linkSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { SourceAssetSchema, writeJson, readJsonIfExists, type SourceAsset } from "../../../core/src/index.ts";
import { paths, ensureDir } from "../../../adapters/src/env.ts";
import { contentHash } from "../../../adapters/src/media/hash.ts";
import { probeMedia, pickSpeechStream } from "../../../adapters/src/media/probe.ts";
import { extractAudio, makeProxy } from "../../../adapters/src/media/ffmpeg.ts";
import { resolveUrl } from "../../../adapters/src/acquire/url.ts";
import { acquireYouTube, AcquisitionError, youtubeCacheDir } from "../../../adapters/src/acquire/youtube.ts";
import { redact } from "../../../adapters/src/proc.ts";
import { P, nowIso, saveProject, type Project } from "../project.ts";
import { cancellation } from "../jobs.ts";
import { info, stage, warn } from "../ui.ts";

const MEDIA_EXT = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts", ".wav", ".mp3", ".m4a", ".aac", ".flac"]);

export interface IngestOptions {
  role?: SourceAsset["role"];
  /** Re-run probing/derivation even when cached. */
  force?: boolean;
}

/** Hardlink into the cache when on the same volume (protects against moves, costs no space). */
function cacheOriginal(src: string, cacheDir: string): string {
  const dest = join(cacheDir, `original${extname(src).toLowerCase()}`);
  if (existsSync(dest)) return dest;
  try {
    linkSync(src, dest);
    return dest;
  } catch {
    return src; // different volume: reference in place (recorded in provenance)
  }
}

async function deriveMedia(asset: SourceAsset, cacheDir: string, force: boolean): Promise<SourceAsset> {
  const probe = asset.probe;
  const derived = { ...asset.derived };
  const speech = pickSpeechStream(probe);
  if (speech) {
    const a16 = join(cacheDir, "audio16k.wav");
    if (force || !existsSync(a16)) {
      stage("audio", "16 kHz mono analysis track (aligned to source time zero)");
      await extractAudio(asset.localPath, a16, { rate: 16000, channels: 1, streamIndex: speech.index }, { signal: cancellation.signal });
    }
    derived.audio16k = { path: a16, sampleRate: 16000, channels: 1, streamIndex: speech.index };
    const a48 = join(cacheDir, "audio48k.wav");
    const ch = Math.min(2, speech.channels);
    if (force || !existsSync(a48)) {
      stage("audio", `48 kHz ${ch === 1 ? "mono" : "stereo"} edit track`);
      await extractAudio(asset.localPath, a48, { rate: 48000, channels: ch, streamIndex: speech.index, codec: "pcm_s24le" }, { signal: cancellation.signal });
    }
    derived.audio48k = { path: a48, sampleRate: 48000, channels: ch, streamIndex: speech.index };
  } else {
    warn(`${asset.id}: no audio stream — transcription and audio analysis are unavailable for this source`);
  }
  if (probe.video) {
    const proxy = join(cacheDir, "proxy.mp4");
    let dims = { width: 0, height: 0 };
    if (force || !existsSync(proxy)) {
      stage("proxy", "360p analysis proxy (timestamps preserved)");
      dims = await makeProxy(asset.localPath, proxy, probe.video.displayWidth, probe.video.displayHeight, { signal: cancellation.signal });
    } else {
      const pp = await probeMedia(proxy);
      dims = { width: pp.video?.displayWidth ?? 0, height: pp.video?.displayHeight ?? 0 };
    }
    derived.analysisProxy = { path: proxy, width: dims.width, height: dims.height, fps: probe.video.fps };
    if (probe.video.isHDR) {
      derived.colorPath = `HDR (${probe.video.hdrKind}) source: analysis proxies are not tone mapped; final renders use the documented LUT path (docs/COLOR.md)`;
      warn(`${asset.id}: HDR ${probe.video.hdrKind} source detected; see docs/COLOR.md`);
    }
  }
  return { ...asset, derived };
}

async function ingestFile(p: Project, file: string, kind: SourceAsset["kind"], input: string, opts: IngestOptions, provenance: Partial<SourceAsset["provenance"]> = {}, extra: Partial<SourceAsset> = {}): Promise<SourceAsset> {
  const abs = resolve(file);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`not a file: ${abs}`);
  stage("hash", basename(abs));
  const sourcesCache = ensureDir(join(paths().cacheDir, "sources"));
  const hash = await contentHash(abs, sourcesCache);
  const id = `src-${hash.slice(7, 15)}`;
  const cacheDir = ensureDir(join(sourcesCache, hash.slice(7, 23)));
  const sourceFile = join(P.source(p, id), "source.json");
  const existing = readJsonIfExists(sourceFile, SourceAssetSchema);
  if (existing && !opts.force && existsSync(existing.localPath)) {
    info(`  ↺ ${id} already ingested (content hash match)`);
    if (!p.config.sources.includes(id)) {
      p.config.sources = [...p.config.sources, id];
      saveProject(p);
    }
    return existing;
  }
  const localPath = cacheOriginal(abs, cacheDir);
  stage("probe", basename(abs));
  const probe = await probeMedia(localPath);
  if (!probe.video && probe.audio.length === 0) throw new Error(`${abs} has no decodable audio or video streams`);
  let asset: SourceAsset = SourceAssetSchema.parse({
    schemaVersion: 1,
    id,
    kind,
    role: opts.role ?? extra.role ?? "primary",
    input: redact(input),
    ...extra,
    localPath,
    contentHash: hash,
    sizeBytes: statSync(localPath).size,
    acquisition: extra.acquisition ?? { status: "local", attempts: [] },
    provenance: { attribution: provenance.attribution ?? basename(abs), ...provenance },
    subtitles: extra.subtitles ?? [],
    probe,
    derived: {},
    createdAt: nowIso(),
  });
  asset = await deriveMedia(asset, cacheDir, Boolean(opts.force));
  asset = SourceAssetSchema.parse(asset);
  writeJson(sourceFile, asset);
  if (!p.config.sources.includes(id)) p.config.sources = [...p.config.sources, id];
  saveProject(p);
  const v = probe.video;
  info(
    `  ✓ ${id}: ${(probe.durationFlicks / 705_600_000).toFixed(2)} s` +
      (v ? `, ${v.displayWidth}x${v.displayHeight} @ ${(v.fps.num / v.fps.den).toFixed(3)} fps${v.isVFR ? " (VFR)" : ""}${v.rotation ? `, rotated ${v.rotation}°` : ""}${v.isHDR ? `, HDR ${v.hdrKind}` : ""}` : ", audio only") +
      (probe.audio[0] ? `, audio ${probe.audio[0].channels} ch @ ${probe.audio[0].sampleRate} Hz` : ", no audio"),
  );
  return asset;
}

interface ManifestEntry {
  path?: string;
  url?: string;
  role?: SourceAsset["role"];
}

export async function ingest(p: Project, inputs: string[], opts: IngestOptions = {}): Promise<SourceAsset[]> {
  const out: SourceAsset[] = [];
  for (const input of inputs) {
    if (/^https?:\/\//i.test(input)) {
      const resolved = resolveUrl(input);
      for (const n of resolved.notes) info(`  ℹ ${n}`);
      if (resolved.kind === "youtube-playlist") {
        throw new Error(`${input} is a playlist. Pass the individual video URLs you want (or ask Claude to list the playlist first).`);
      }
      if (resolved.kind !== "youtube-video") throw new Error(`direct URL downloads are not supported yet for ${input}; download it and ingest the local file`);
      stage("acquire", `${resolved.normalized} (yt-dlp)`);
      let acq;
      try {
        acq = await acquireYouTube(resolved, youtubeCacheDir(resolved.videoId!), { signal: cancellation.signal, onProgress: (l) => info(`  ${l}`) });
      } catch (e) {
        if (e instanceof AcquisitionError) {
          writeJson(join(P.state(p), "acquisition-failure.json"), { input: redact(input), diagnosis: e.diagnosis, attempts: e.attempts, message: e.message, at: nowIso() });
        }
        throw e;
      }
      const inf = acq.info;
      out.push(
        await ingestFile(
          p,
          acq.path,
          "youtube",
          input,
          opts,
          {
            ...(inf.title ? { title: inf.title } : {}),
            ...(inf.uploader ? { uploader: inf.uploader } : {}),
            ...(inf.channel ? { channel: inf.channel } : {}),
            ...(inf.channelUrl ? { channelUrl: inf.channelUrl } : {}),
            webpageUrl: inf.webpageUrl ?? resolved.normalized,
            ...(inf.uploadDate ? { uploadDate: inf.uploadDate } : {}),
            ...(inf.license ? { license: inf.license } : {}),
            ...(inf.description ? { description: inf.description } : {}),
            attribution: `${inf.title ?? resolved.videoId} — ${inf.channel ?? inf.uploader ?? "YouTube"} (${resolved.normalized})`,
          },
          {
            normalizedUrl: resolved.normalized,
            youtubeId: resolved.videoId!,
            ...(resolved.playlistId ? { playlistId: resolved.playlistId } : {}),
            ...(resolved.startHint !== undefined ? { startHintFlicks: resolved.startHint } : {}),
            acquisition: { status: "acquired", tool: "yt-dlp", toolVersion: acq.toolVersion, ...(inf.formatId ? { formatId: inf.formatId } : {}), attempts: acq.attempts.map((a) => ({ ...a })), completedAt: nowIso() },
            subtitles: acq.subtitles,
          },
        ),
      );
      continue;
    }
    const abs = resolve(input);
    if (!existsSync(abs)) throw new Error(`input not found: ${input}`);
    if (statSync(abs).isDirectory()) {
      const files = readdirSync(abs)
        .filter((f) => MEDIA_EXT.has(extname(f).toLowerCase()))
        .sort();
      if (files.length === 0) throw new Error(`no media files in ${abs}`);
      for (const f of files) out.push(await ingestFile(p, join(abs, f), "folder-item", join(input, f), opts));
      continue;
    }
    if (extname(abs).toLowerCase() === ".json") {
      const manifest = JSON.parse(readFileSync(abs, "utf8")) as { sources?: ManifestEntry[] };
      for (const entry of manifest.sources ?? []) {
        const target = entry.url ?? (entry.path ? resolve(abs, "..", entry.path) : null);
        if (!target) continue;
        out.push(...(await ingest(p, [target], { ...opts, ...(entry.role ? { role: entry.role } : {}) })));
      }
      continue;
    }
    out.push(await ingestFile(p, abs, "file", input, opts));
  }
  return out;
}

export function loadSource(p: Project, id: string): SourceAsset {
  const f = join(P.source(p, id), "source.json");
  const s = readJsonIfExists(f, SourceAssetSchema);
  if (!s) throw new Error(`unknown source ${id} in project ${p.config.id}`);
  return s;
}

export function defaultSource(p: Project, role?: SourceAsset["role"]): SourceAsset {
  const all = p.config.sources.map((id) => loadSource(p, id));
  const pick = role ? all.find((s) => s.role === role) : all.find((s) => s.role === "primary" || s.role === "camera") ?? all[0];
  if (!pick) throw new Error(`project ${p.config.id} has no ${role ?? ""} source; run: shorts-studio ingest ${p.config.id} <file-or-url>`);
  return pick;
}
