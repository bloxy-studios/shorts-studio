import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Filesystem layout.
 *
 * pluginRoot   read-only plugin files (skills, presets, templates, fonts, python src).
 * runtimeHome  writable per-machine runtime: python venv, pinned HyperFrames install,
 *              whisper.cpp build, downloaded models. Resolution order:
 *              SHORTS_STUDIO_HOME → CLAUDE_PLUGIN_DATA → <pluginRoot>/.runtime (dev checkout)
 *              → ~/.shorts-studio.
 * workspace    writable user workspace (projects, caches, preferences):
 *              --workspace flag → SHORTS_STUDIO_WORKSPACE → current directory.
 *
 * Outputs are never written inside pluginRoot unless it is the dev checkout's
 * explicit workspace.
 */
export interface StudioPaths {
  pluginRoot: string;
  runtimeHome: string;
  runtimeSource: "SHORTS_STUDIO_HOME" | "CLAUDE_PLUGIN_DATA" | "dev-checkout" | "home";
  workspace: string;
  projectsDir: string;
  cacheDir: string;
  preferencesFile: string;
  presetsDir: string;
  templatesDir: string;
  fontsDir: string;
  pythonSrc: string;
  venvDir: string;
  pythonBin: string;
  binDir: string;
  modelsDir: string;
  nodeDir: string;
}

function findPluginRoot(): string {
  for (const env of [process.env.SHORTS_STUDIO_PLUGIN_ROOT, process.env.CLAUDE_PLUGIN_ROOT]) {
    if (env && existsSync(join(env, ".claude-plugin", "plugin.json"))) return resolve(env);
  }
  // Walk up from this module (works for source runs and the bundled dist/shorts-studio.js);
  // fileURLToPath decodes %20 etc. so install paths with spaces work.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".claude-plugin", "plugin.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("cannot locate the shorts-studio plugin root (.claude-plugin/plugin.json)");
}

let cached: StudioPaths | null = null;
let workspaceOverride: string | null = null;

export function setWorkspace(path: string): void {
  workspaceOverride = resolve(path);
  cached = null;
}

export function paths(): StudioPaths {
  if (cached) return cached;
  const pluginRoot = findPluginRoot();
  let runtimeHome: string;
  let runtimeSource: StudioPaths["runtimeSource"];
  if (process.env.SHORTS_STUDIO_HOME) {
    runtimeHome = resolve(process.env.SHORTS_STUDIO_HOME);
    runtimeSource = "SHORTS_STUDIO_HOME";
  } else if (process.env.CLAUDE_PLUGIN_DATA) {
    runtimeHome = resolve(process.env.CLAUDE_PLUGIN_DATA);
    runtimeSource = "CLAUDE_PLUGIN_DATA";
  } else if (existsSync(join(pluginRoot, ".git"))) {
    runtimeHome = join(pluginRoot, ".runtime");
    runtimeSource = "dev-checkout";
  } else {
    runtimeHome = join(homedir(), ".shorts-studio");
    runtimeSource = "home";
  }
  const workspace = workspaceOverride ?? resolve(process.env.SHORTS_STUDIO_WORKSPACE ?? process.cwd());
  const venvDir = join(runtimeHome, "venv");
  cached = {
    pluginRoot,
    runtimeHome,
    runtimeSource,
    workspace,
    projectsDir: join(workspace, "projects"),
    cacheDir: join(workspace, ".shorts-studio", "cache"),
    preferencesFile: join(workspace, ".shorts-studio", "PREFERENCES.md"),
    presetsDir: join(pluginRoot, "presets"),
    templatesDir: join(pluginRoot, "templates"),
    fontsDir: join(pluginRoot, "assets", "fonts"),
    pythonSrc: join(pluginRoot, "python"),
    venvDir,
    pythonBin: join(venvDir, "bin", "python"),
    binDir: join(runtimeHome, "bin"),
    modelsDir: join(runtimeHome, "models"),
    nodeDir: join(runtimeHome, "node"),
  };
  return cached;
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

/** Refuses to write deliverables into the installed plugin directory. */
export function assertWritableOutput(path: string): void {
  const p = paths();
  const abs = resolve(path);
  const insidePlugin = abs === p.pluginRoot || abs.startsWith(`${p.pluginRoot}/`);
  const insideWorkspace = abs === p.workspace || abs.startsWith(`${p.workspace}/`);
  if (insidePlugin && !insideWorkspace) {
    throw new Error(`refusing to write ${abs} inside the plugin installation; use a workspace directory`);
  }
}
