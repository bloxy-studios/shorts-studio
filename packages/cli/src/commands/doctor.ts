import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, totalmem } from "node:os";
import { join } from "node:path";
import { paths } from "../../../adapters/src/env.ts";
import { run } from "../../../adapters/src/proc.ts";
import { tryTool } from "../../../adapters/src/tools.ts";
import { CHROME_HEADLESS_SHELL, GSAP_VERSION, HYPERFRAMES_VERSION, chromeHeadlessShell, hyperframesBin } from "../../../adapters/src/hyperframes.ts";
import { info, stage, warn } from "../ui.ts";

export interface Check {
  id: string;
  ok: boolean;
  level: "required" | "recommended" | "optional";
  detail: string;
  fix?: string;
}

/** Models fetched by setup, pinned by URL + sha256 (licenses in docs/LICENSES.md). */
export const MODELS: Array<{ id: string; dest: string; url: string; sha256: string | null; sizeMb: number; required: boolean; note: string }> = [
  { id: "yunet", dest: "cv/face_detection_yunet_2023mar.onnx", url: "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx", sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4", sizeMb: 0.2, required: true, note: "OpenCV YuNet face detector (MIT)" },
  { id: "whisper-base.en", dest: "whisper/ggml-base.en.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin", sha256: null, sizeMb: 148, required: true, note: "Whisper base.en (MIT) — fast English drafts" },
  { id: "whisper-small.en", dest: "whisper/ggml-small.en.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin", sha256: null, sizeMb: 488, required: false, note: "Whisper small.en (MIT) — better English final captions" },
  { id: "whisper-small", dest: "whisper/ggml-small.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin", sha256: null, sizeMb: 488, required: false, note: "Whisper small multilingual (MIT) — Kiswahili / mixed-language path" },
  { id: "silero-vad", dest: "whisper/ggml-silero-v6.2.0.bin", url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin", sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987", sizeMb: 0.9, required: false, note: "Silero VAD v6.2 for whisper.cpp (MIT)" },
];

const WHISPER_CPP_COMMIT = "6e4ab854f67f743900934a703d5603419384c961";

async function version(cmd: string[], re: RegExp): Promise<string | null> {
  try {
    const r = await run(cmd, { allowFailure: true, timeoutMs: 60_000 });
    const m = re.exec(`${r.stdout}\n${r.stderr}`);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function runChecks(): Promise<{ checks: Check[]; environment: Record<string, unknown> }> {
  const p = paths();
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const fsStat = statfsSync(p.workspace);
  const freeGb = (fsStat.bavail * fsStat.bsize) / 1024 ** 3;
  add({ id: "disk", ok: freeGb > 5, level: "required", detail: `${freeGb.toFixed(1)} GB free in the workspace volume`, fix: "Free disk space; renders and caches need several GB." });

  const bunV = process.versions.bun ?? null;
  add({ id: "bun", ok: Boolean(bunV), level: "required", detail: `bun ${bunV ?? "missing"}` });
  const nodeBin = tryTool("node");
  const nodeV = nodeBin ? await version([nodeBin, "--version"], /v(\d+\.\d+\.\d+)/) : null;
  add({ id: "node", ok: Boolean(nodeV && Number(nodeV.split(".")[0]) >= 22), level: "required", detail: `node ${nodeV ?? "missing"} (HyperFrames needs >= 22)`, fix: "Install Node.js 22 or newer." });

  const ffmpeg = tryTool("ffmpeg");
  const ffV = ffmpeg ? await version([ffmpeg, "-version"], /ffmpeg version (\S+)/) : null;
  add({ id: "ffmpeg", ok: Boolean(ffV), level: "required", detail: `ffmpeg ${ffV ?? "missing"} at ${ffmpeg ?? "-"}`, fix: "brew install ffmpeg (or set SS_FFMPEG_BIN)" });
  if (ffmpeg) {
    const filters = (await run([ffmpeg, "-hide_banner", "-filters"], { allowFailure: true })).stdout;
    const encoders = (await run([ffmpeg, "-hide_banner", "-encoders"], { allowFailure: true })).stdout;
    const needF = ["ebur128", "overlay", "alphamerge", "scdet", "blackdetect", "freezedetect", "afftdn", "deesser", "acompressor", "alimiter", "amix", "tmix", "lut3d"];
    const missingF = needF.filter((f) => !new RegExp(`\\s${f}\\s`).test(filters));
    const needE = ["libx264", "aac", "qtrle"];
    const missingE = needE.filter((e) => !new RegExp(`\\s${e}\\s`).test(encoders));
    add({ id: "ffmpeg-features", ok: missingF.length === 0 && missingE.length === 0, level: "required", detail: missingF.length || missingE.length ? `missing filters ${missingF.join(",") || "-"}; encoders ${missingE.join(",") || "-"}` : `all ${needF.length} filters and ${needE.length} encoders present`, fix: "Use an FFmpeg build with libx264 and the standard filters." });
    add({ id: "ffmpeg-zscale", ok: /\szscale\s/.test(filters), level: "optional", detail: /\szscale\s/.test(filters) ? "zscale present (HDR tone mapping via zscale)" : "zscale absent: HDR sources use the documented LUT path (docs/COLOR.md)" });
  }
  const ffprobe = tryTool("ffprobe");
  add({ id: "ffprobe", ok: Boolean(ffprobe), level: "required", detail: `ffprobe at ${ffprobe ?? "missing"}` });

  const py = existsSync(p.pythonBin) ? p.pythonBin : null;
  const pyV = py ? await version([py, "--version"], /Python (\S+)/) : null;
  add({ id: "python-venv", ok: Boolean(pyV), level: "required", detail: py ? `venv python ${pyV} at ${p.venvDir}` : "runtime venv missing", fix: "shorts-studio doctor --setup" });
  if (py) {
    const probe = await run([py, "-c", "import numpy, scipy, cv2, PIL, soundfile, pyloudnorm, fontTools; print(numpy.__version__, scipy.__version__, cv2.__version__)"], { allowFailure: true, env: { PYTHONPATH: p.pythonSrc } });
    add({ id: "python-packages", ok: probe.code === 0, level: "required", detail: probe.code === 0 ? `numpy/scipy/opencv ${probe.stdout.trim()}` : probe.stderr.trim().split("\n").pop() ?? "import failed", fix: "shorts-studio doctor --setup" });
  }
  const ytdlp = tryTool("yt-dlp");
  const ytV = ytdlp ? await version([ytdlp, "--version"], /(\d{4}\.\d{2}\.\d{2}\S*)/) : null;
  add({ id: "yt-dlp", ok: Boolean(ytV), level: "recommended", detail: ytV ? `yt-dlp ${ytV} at ${ytdlp}` : "yt-dlp missing (YouTube acquisition unavailable)", fix: "shorts-studio doctor --setup (installs yt-dlp into the runtime venv)" });

  const whisper = tryTool("whisper-cli");
  add({ id: "whisper.cpp", ok: Boolean(whisper), level: "required", detail: whisper ? `whisper-cli at ${whisper}` : "whisper-cli missing", fix: "shorts-studio doctor --setup (builds whisper.cpp locally with cmake)" });
  for (const m of MODELS) {
    const f = join(p.modelsDir, m.dest);
    add({ id: `model:${m.id}`, ok: existsSync(f), level: m.required ? "required" : "optional", detail: existsSync(f) ? `${m.note} — ${f}` : `${m.note} — not downloaded (~${m.sizeMb} MB)`, fix: `shorts-studio doctor --setup --models ${m.id}` });
  }

  const hf = hyperframesBin();
  const hfV = hf ? await version([hf, "--version"], /(\d+\.\d+\.\d+)/) : null;
  add({ id: "hyperframes", ok: hfV === HYPERFRAMES_VERSION, level: "required", detail: hfV ? `hyperframes ${hfV} (pinned ${HYPERFRAMES_VERSION})` : "HyperFrames not installed in the runtime", fix: "shorts-studio doctor --setup" });
  add({ id: "gsap", ok: existsSync(join(p.nodeDir, "node_modules", "gsap", "dist", "gsap.min.js")), level: "required", detail: `gsap ${GSAP_VERSION} for compositions` });
  const chrome = chromeHeadlessShell();
  add({ id: "chrome", ok: Boolean(chrome), level: "required", detail: chrome ? `chrome-headless-shell ${CHROME_HEADLESS_SHELL} (pinned for HyperFrames render)` : `pinned chrome-headless-shell ${CHROME_HEADLESS_SHELL} missing`, fix: "shorts-studio doctor --setup" });
  for (const f of ["Poppins-Bold.ttf", "InstrumentSerif-Italic.ttf", "Inter-Variable.ttf", "Anton-Regular.ttf", "Fredoka-Variable.ttf", "metrics.json"]) {
    if (!existsSync(join(p.fontsDir, f))) add({ id: `font:${f}`, ok: false, level: "required", detail: `bundled font ${f} missing from the plugin` });
  }

  const environment = {
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    pluginRoot: p.pluginRoot,
    runtimeHome: p.runtimeHome,
    runtimeSource: p.runtimeSource,
    workspace: p.workspace,
    acceleration: "CPU only (no CUDA/Metal requirement); HyperFrames low-memory mode auto-enables at <= 8 GB RAM",
  };
  return { checks, environment };
}

async function download(url: string, dest: string, sha256: string | null): Promise<void> {
  mkdirSync(join(dest, ".."), { recursive: true });
  const tmp = `${dest}.part`;
  await run(["curl", "-fL", "--retry", "3", "--retry-delay", "3", "-C", "-", "-o", tmp, url], { timeoutMs: 3 * 3600_000, allowFailure: false });
  if (sha256) {
    const h = createHash("sha256").update(readFileSync(tmp)).digest("hex");
    if (h !== sha256) throw new Error(`checksum mismatch for ${url}: ${h}`);
  }
  await run(["mv", tmp, dest]);
}

/** Installs the project-local runtime. Never uses sudo, global npm, or global pip. */
export async function setup(opts: { models?: string[]; skipWhisperBuild?: boolean } = {}): Promise<string[]> {
  const p = paths();
  const done: string[] = [];
  mkdirSync(p.runtimeHome, { recursive: true });
  const uv = tryTool("uv");
  if (!existsSync(p.pythonBin)) {
    if (!uv) throw new Error("uv is required to create the local Python environment (https://docs.astral.sh/uv/)");
    stage("setup", "Python 3.12 virtual environment (uv, project-local)");
    await run([uv, "venv", "--python", "3.12", p.venvDir], { env: { UV_PYTHON_INSTALL_DIR: join(p.runtimeHome, "python") }, timeoutMs: 1800_000 });
    done.push("python venv");
  }
  if (uv) {
    stage("setup", "Python packages (numpy, scipy, opencv-headless, pillow, pyloudnorm, soundfile, fonttools, yt-dlp)");
    await run([uv, "pip", "install", "--python", p.pythonBin, "-r", join(p.pythonSrc, "requirements-base.txt"), "yt-dlp[default]"], { timeoutMs: 3600_000 });
    done.push("python packages");
  }
  if (hyperframesBin() === null || !existsSync(join(p.nodeDir, "node_modules", "gsap"))) {
    stage("setup", `HyperFrames ${HYPERFRAMES_VERSION} + gsap ${GSAP_VERSION} (pinned, local)`);
    mkdirSync(p.nodeDir, { recursive: true });
    writeFileSync(join(p.nodeDir, "package.json"), JSON.stringify({ name: "shorts-studio-runtime", private: true, dependencies: { hyperframes: HYPERFRAMES_VERSION, gsap: GSAP_VERSION } }, null, 2));
    const npm = tryTool("node") ? "npm" : null;
    if (!npm) throw new Error("Node.js >= 22 is required for HyperFrames");
    await run(["npm", "install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: p.nodeDir, timeoutMs: 3600_000 });
    done.push("hyperframes");
  }
  if (!chromeHeadlessShell()) {
    stage("setup", `chrome-headless-shell ${CHROME_HEADLESS_SHELL} (~200 MB, used only for rendering)`);
    const browsers = join(p.nodeDir, "node_modules", ".bin", "browsers");
    await run([browsers, "install", `chrome-headless-shell@${CHROME_HEADLESS_SHELL}`, "--path", join(p.runtimeHome, "browsers")], { timeoutMs: 3600_000 });
    done.push("chrome");
  }
  if (!tryTool("whisper-cli") && !opts.skipWhisperBuild) {
    const src = join(p.runtimeHome, "src", "whisper.cpp");
    stage("setup", "building whisper.cpp (static, CPU) — a few minutes");
    if (!existsSync(join(src, "CMakeLists.txt"))) {
      await run(["git", "clone", "--filter=blob:none", "https://github.com/ggml-org/whisper.cpp", src], { timeoutMs: 3600_000 });
      await run(["git", "-C", src, "checkout", WHISPER_CPP_COMMIT], { timeoutMs: 600_000 });
    }
    await run(["cmake", "-B", join(src, "build-static"), "-S", src, "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF", "-DWHISPER_BUILD_TESTS=OFF", "-DGGML_METAL=OFF"], { timeoutMs: 1800_000 });
    await run(["cmake", "--build", join(src, "build-static"), "--config", "Release", "-j", "3", "--target", "whisper-cli"], { timeoutMs: 3600_000 });
    mkdirSync(p.binDir, { recursive: true });
    await run(["cp", join(src, "build-static", "bin", "whisper-cli"), join(p.binDir, "whisper-cli")]);
    done.push("whisper.cpp");
  }
  const wanted = new Set(opts.models ?? MODELS.filter((m) => m.required).map((m) => m.id));
  for (const m of MODELS) {
    if (!wanted.has(m.id)) continue;
    const f = join(p.modelsDir, m.dest);
    if (existsSync(f)) continue;
    stage("setup", `model ${m.id} (~${m.sizeMb} MB): ${m.note}`);
    await download(m.url, f, m.sha256);
    done.push(`model ${m.id}`);
  }
  if (done.length === 0) info("  runtime already complete");
  else warn(`installed: ${done.join(", ")}`);
  return done;
}
