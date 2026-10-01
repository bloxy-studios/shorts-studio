import { parseTimecode, type Flicks } from "../../../core/src/index.ts";

export interface ResolvedUrl {
  kind: "youtube-video" | "youtube-playlist" | "url";
  normalized: string;
  videoId?: string;
  playlistId?: string;
  /** t= / start= hint; analysis still covers the full video unless explicitly asked. */
  startHint?: Flicks;
  notes: string[];
}

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
]);

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

function parseStart(v: string | null): Flicks | undefined {
  if (!v) return undefined;
  try {
    return parseTimecode(/^\d+$/.test(v) ? `${v}s` : v);
  } catch {
    return undefined;
  }
}

/** Normalizes YouTube URL variants and separates a single video from a playlist. */
export function resolveUrl(input: string): ResolvedUrl {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(`not a URL: ${input}`);
  }
  const host = url.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return { kind: "url", normalized: url.toString(), notes: [] };
  const notes: string[] = [];
  let videoId: string | undefined;
  if (host === "youtu.be") videoId = url.pathname.slice(1).split("/")[0];
  else if (url.pathname === "/watch") videoId = url.searchParams.get("v") ?? undefined;
  else {
    const m = /^\/(?:shorts|live|embed|v|e)\/([^/?#]+)/.exec(url.pathname);
    if (m) videoId = m[1];
  }
  const playlistId = url.searchParams.get("list") ?? undefined;
  const startHint = parseStart(url.searchParams.get("t") ?? url.searchParams.get("start"));
  if (startHint !== undefined) notes.push("URL contains a start-time hint; the full video is analyzed unless you ask to begin there");
  if (videoId && ID_RE.test(videoId)) {
    if (playlistId) notes.push(`URL also references playlist ${playlistId}; treating it as the single video`);
    return {
      kind: "youtube-video",
      normalized: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      ...(playlistId ? { playlistId } : {}),
      ...(startHint !== undefined ? { startHint } : {}),
      notes,
    };
  }
  if (playlistId) {
    return { kind: "youtube-playlist", normalized: `https://www.youtube.com/playlist?list=${playlistId}`, playlistId, notes };
  }
  throw new Error(`could not find a YouTube video or playlist id in ${input}`);
}

export type AcquisitionDiagnosis =
  | "ok"
  | "missing-dependency"
  | "extractor-outdated"
  | "unavailable"
  | "sign-in-required"
  | "geo-restricted"
  | "network"
  | "private"
  | "live-or-upcoming"
  | "unknown";

/** Classifies yt-dlp failures so recovery is bounded and appropriate. */
export function diagnoseYtDlp(stderr: string): AcquisitionDiagnosis {
  const s = stderr.toLowerCase();
  if (/command not found|no such file or directory.*yt-dlp|enoent/.test(s)) return "missing-dependency";
  if (/sign in to confirm|confirm you.re not a bot|login required|members-only|age-restricted|use --cookies/.test(s)) return "sign-in-required";
  if (/private video/.test(s)) return "private";
  if (/available in your country|blocked it in your country|geo.?restrict/.test(s)) return "geo-restricted";
  if (/this live event|premieres in|is upcoming|live stream/.test(s)) return "live-or-upcoming";
  if (/video unavailable|has been removed|account.*terminated|does not exist|404: not found/.test(s)) return "unavailable";
  if (/nsig extraction failed|signature extraction failed|unable to extract|requested format is not available|js challenge|no supported javascript runtime|please update|outdated/.test(s)) return "extractor-outdated";
  if (/timed out|getaddrinfo|temporary failure|connection (reset|refused)|network is unreachable|ssl|http error 429|too many requests/.test(s)) return "network";
  return "unknown";
}
