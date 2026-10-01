import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../env.ts";
import { ProcessError, run } from "../proc.ts";
import { tool, tryTool } from "../tools.ts";
import { diagnoseYtDlp, type AcquisitionDiagnosis, type ResolvedUrl } from "./url.ts";

export interface AcquisitionAttemptRecord {
  at: string;
  tool: string;
  toolVersion?: string;
  ok: boolean;
  diagnosis: AcquisitionDiagnosis;
  message?: string;
}

export interface YouTubeAcquisition {
  path: string;
  info: {
    id: string;
    title?: string;
    uploader?: string;
    channel?: string;
    channelUrl?: string;
    webpageUrl?: string;
    uploadDate?: string;
    license?: string;
    description?: string;
    durationSec?: number;
    formatId?: string;
    language?: string;
  };
  subtitles: Array<{ language: string; kind: "manual" | "auto"; path: string }>;
  toolVersion: string;
  attempts: AcquisitionAttemptRecord[];
}

export class AcquisitionError extends Error {
  constructor(
    message: string,
    readonly diagnosis: AcquisitionDiagnosis,
    readonly attempts: AcquisitionAttemptRecord[],
  ) {
    super(message);
    this.name = "AcquisitionError";
  }
}

/** Prefer H.264 ≤1080p + AAC (fast local decode on Intel), fall back to best ≤1080p. */
const FORMAT = "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b";

async function ytDlpVersion(bin: string): Promise<string> {
  const r = await run([bin, "--version"], { allowFailure: true, timeoutMs: 30_000 });
  return r.stdout.trim() || "unknown";
}

function jsRuntimeArgs(): string[] {
  // yt-dlp needs an external JS runtime for YouTube challenges; Node is required by
  // HyperFrames anyway, so enable it explicitly (Deno is yt-dlp's default).
  const node = tryTool("node");
  return node ? ["--js-runtimes", `node:${node}`] : [];
}

async function updateLocalYtDlp(): Promise<boolean> {
  const uv = tryTool("uv");
  const py = tryTool("python");
  if (!uv || !py) return false;
  const r = await run([uv, "pip", "install", "--python", py, "--upgrade", "yt-dlp[default]"], { allowFailure: true, timeoutMs: 600_000 });
  return r.code === 0;
}

async function verifyDecodes(file: string): Promise<void> {
  const ffmpeg = tool("ffmpeg");
  await run([ffmpeg, "-v", "error", "-nostdin", "-i", file, "-t", "3", "-f", "null", "-"], { timeoutMs: 120_000 });
  await run([ffmpeg, "-v", "error", "-nostdin", "-sseof", "-3", "-i", file, "-f", "null", "-"], { timeoutMs: 120_000 });
}

export async function acquireYouTube(
  resolved: ResolvedUrl,
  destDir: string,
  opts: { signal?: AbortSignal; allowUpdate?: boolean; onProgress?: (line: string) => void } = {},
): Promise<YouTubeAcquisition> {
  if (resolved.kind !== "youtube-video" || !resolved.videoId) throw new Error("acquireYouTube expects a single video URL");
  mkdirSync(destDir, { recursive: true });
  const attempts: AcquisitionAttemptRecord[] = [];
  let updated = false;
  let networkRetried = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    let bin: string;
    try {
      bin = tool("yt-dlp");
    } catch (e) {
      attempts.push({ at: new Date().toISOString(), tool: "yt-dlp", ok: false, diagnosis: "missing-dependency", message: (e as Error).message });
      throw new AcquisitionError("yt-dlp is not installed; run `ss doctor --setup`", "missing-dependency", attempts);
    }
    const version = await ytDlpVersion(bin);
    const args = [
      bin,
      "--no-playlist",
      "--newline",
      "--no-colors",
      "--restrict-filenames",
      "-f",
      FORMAT,
      "--merge-output-format",
      "mp4",
      "--write-info-json",
      "--no-update",
      "--ffmpeg-location",
      tool("ffmpeg"),
      ...jsRuntimeArgs(),
      "-o",
      join(destDir, "%(id)s.%(ext)s"),
      "--print",
      "after_move:filepath",
      resolved.normalized,
    ];
    try {
      const res = await run(args, {
        timeoutMs: 4 * 3600_000,
        ...(opts.signal ? { signal: opts.signal } : {}),
        onStderrLine: (l) => {
          if (/\[download\]\s+\d/.test(l) && opts.onProgress) opts.onProgress(l.trim());
        },
      });
      const printed = res.stdout.trim().split("\n").filter(Boolean).pop();
      const file = printed && existsSync(printed) ? printed : findMedia(destDir, resolved.videoId);
      if (!file) throw new ProcessError("yt-dlp finished but no media file was found", res);
      if (statSync(file).size === 0) throw new ProcessError("downloaded file is empty", res);
      await verifyDecodes(file);
      attempts.push({ at: new Date().toISOString(), tool: "yt-dlp", toolVersion: version, ok: true, diagnosis: "ok" });
      // Subtitles are optional hints: fetch them separately so a caption failure
      // (e.g. HTTP 429 rate limiting) never fails the media acquisition.
      const subs = await run(
        [bin, "--skip-download", "--no-update", "--no-playlist", "--write-subs", "--write-auto-subs", "--sub-langs", "en,en-orig,sw,sw-orig", "--sub-format", "vtt", ...jsRuntimeArgs(), "-o", join(destDir, "%(id)s.%(ext)s"), resolved.normalized],
        { allowFailure: true, timeoutMs: 600_000, ...(opts.signal ? { signal: opts.signal } : {}) },
      );
      const fetched = findSubs(destDir, resolved.videoId);
      if (subs.code !== 0) {
        opts.onProgress?.(
          fetched.length
            ? `subtitles partly fetched (${fetched.map((x) => `${x.language}/${x.kind}`).join(", ")}); others failed (${diagnoseYtDlp(subs.stderr)}) — they are optional hints`
            : `subtitles unavailable (${diagnoseYtDlp(subs.stderr)}): continuing without them`,
        );
      }
      return { path: file, info: readInfo(destDir, resolved.videoId), subtitles: fetched, toolVersion: version, attempts };
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      const stderr = e instanceof ProcessError ? e.result.stderr : (e as Error).message;
      const diagnosis = diagnoseYtDlp(stderr);
      attempts.push({ at: new Date().toISOString(), tool: "yt-dlp", toolVersion: version, ok: false, diagnosis, message: stderr.trim().split("\n").slice(-4).join(" | ").slice(0, 600) });
      if (diagnosis === "extractor-outdated" && opts.allowUpdate !== false && !updated) {
        updated = true;
        if (await updateLocalYtDlp()) continue;
      }
      if (diagnosis === "network" && !networkRetried) {
        networkRetried = true;
        await Bun.sleep(/429|too many requests/i.test(stderr) ? 30_000 : 5000);
        continue;
      }
      const advice: Partial<Record<AcquisitionDiagnosis, string>> = {
        "sign-in-required": "YouTube requires sign-in for this video. Provide an authorized local copy instead (credentials are never probed).",
        private: "The video is private. Provide an authorized local copy.",
        "geo-restricted": "The video is not available from this location. Provide an authorized local copy.",
        unavailable: "The video is unavailable or removed.",
        "live-or-upcoming": "Live/upcoming streams cannot be clipped until the recording is available.",
        "extractor-outdated": "yt-dlp could not extract this video even after updating the project-local copy.",
        network: "Network error while downloading; check connectivity and retry.",
      };
      throw new AcquisitionError(`${advice[diagnosis] ?? "Download failed."} (${diagnosis})`, diagnosis, attempts);
    }
  }
  throw new AcquisitionError("download failed after bounded retries", "unknown", attempts);
}

function findMedia(dir: string, id: string): string | null {
  const f = readdirSync(dir).find((n) => n.startsWith(`${id}.`) && /\.(mp4|mkv|webm|mov)$/.test(n) && !n.includes(".part"));
  return f ? join(dir, f) : null;
}

function findSubs(dir: string, id: string): YouTubeAcquisition["subtitles"] {
  const info = readInfoRaw(dir, id);
  const manual = new Set(Object.keys((info?.subtitles as Record<string, unknown>) ?? {}));
  return readdirSync(dir)
    .filter((n) => n.startsWith(`${id}.`) && n.endsWith(".vtt"))
    .map((n) => {
      const language = n.slice(id.length + 1, -4);
      return { language, kind: manual.has(language) ? ("manual" as const) : ("auto" as const), path: join(dir, n) };
    });
}

function readInfoRaw(dir: string, id: string): Record<string, unknown> | null {
  const f = join(dir, `${id}.info.json`);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

function readInfo(dir: string, id: string): YouTubeAcquisition["info"] {
  const j = readInfoRaw(dir, id) ?? {};
  const s = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : undefined);
  const desc = s("description");
  return {
    id,
    ...(s("title") ? { title: s("title")! } : {}),
    ...(s("uploader") ? { uploader: s("uploader")! } : {}),
    ...(s("channel") ? { channel: s("channel")! } : {}),
    ...(s("channel_url") ? { channelUrl: s("channel_url")! } : {}),
    ...(s("webpage_url") ? { webpageUrl: s("webpage_url")! } : {}),
    ...(s("upload_date") ? { uploadDate: s("upload_date")! } : {}),
    ...(s("license") ? { license: s("license")! } : {}),
    ...(desc ? { description: desc.slice(0, 2000) } : {}),
    ...(typeof j.duration === "number" ? { durationSec: j.duration } : {}),
    ...(s("format_id") ? { formatId: s("format_id")! } : {}),
    ...(s("language") ? { language: s("language")! } : {}),
  };
}

export function youtubeCacheDir(videoId: string): string {
  return join(paths().cacheDir, "youtube", videoId);
}
