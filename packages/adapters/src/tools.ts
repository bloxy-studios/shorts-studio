import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./env.ts";

export type ToolName = "ffmpeg" | "ffprobe" | "yt-dlp" | "whisper-cli" | "uv" | "node" | "bun" | "python";

export class MissingToolError extends Error {
  constructor(
    readonly tool: string,
    readonly hint: string,
  ) {
    super(`${tool} is not available. ${hint}`);
    this.name = "MissingToolError";
  }
}

const HINTS: Record<ToolName, string> = {
  ffmpeg: "Install FFmpeg (e.g. `brew install ffmpeg`) or set SS_FFMPEG_BIN; run `ss doctor`.",
  ffprobe: "ffprobe ships with FFmpeg; set SS_FFPROBE_BIN if it is not on PATH.",
  "yt-dlp": "Run `ss doctor --setup` to install a project-local yt-dlp, or set SS_YT_DLP_BIN.",
  "whisper-cli": "Run `ss doctor --setup` to build whisper.cpp into the runtime directory.",
  uv: "Install uv (https://docs.astral.sh/uv/) or set SS_UV_BIN; it creates the local Python env.",
  node: "Install Node.js >= 22 (HyperFrames requirement).",
  bun: "Install Bun >= 1.2.",
  python: "Run `ss doctor --setup` to create the local Python virtual environment.",
};

/**
 * Resolves a tool: explicit SS_<NAME>_BIN override → runtime-local binary
 * (installed by doctor --setup) → system PATH. Never installs anything.
 */
export function tryTool(name: ToolName): string | null {
  const envKey = `SS_${name.toUpperCase().replace(/-/g, "_")}_BIN`;
  const override = process.env[envKey];
  if (override && existsSync(override)) return override;
  const p = paths();
  if (name === "python") return existsSync(p.pythonBin) ? p.pythonBin : null;
  const local = join(p.binDir, name);
  if (existsSync(local)) return local;
  if (name === "yt-dlp") {
    const venvYtDlp = join(p.venvDir, "bin", "yt-dlp");
    if (existsSync(venvYtDlp)) return venvYtDlp;
  }
  return Bun.which(name) ?? null;
}

export function tool(name: ToolName): string {
  const found = tryTool(name);
  if (!found) throw new MissingToolError(name, HINTS[name]);
  return found;
}
