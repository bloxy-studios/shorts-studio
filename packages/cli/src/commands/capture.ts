/**
 * Real source-page capture for claims/figures/headlines (spec §17): a full-page PNG from the
 * pinned headless Chrome plus a provenance record. Only http(s) and local file URLs; argument
 * arrays only; nothing is uploaded.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeJson } from "../../../core/src/index.ts";
import { chromeHeadlessShell, CHROME_HEADLESS_SHELL } from "../../../adapters/src/hyperframes.ts";
import { imageSize } from "../../../adapters/src/render/luxury.ts";
import { run } from "../../../adapters/src/proc.ts";
import type { Command } from "../registry.ts";
import { loadProject, nowIso } from "../project.ts";

export const captureCommands: Record<string, Command> = {
  capture: {
    summary: "Capture a real web page (or local HTML file) as a PNG for a Luxury source-page visual, with provenance (URL, time, sha256)",
    usage: "shorts-studio capture <project> <url> [--name ID] [--width 1280] [--height 2400]",
    async run(args) {
      const p = loadProject(args.pos(0, "project"));
      const raw = args.pos(1, "url");
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Error(`not a URL: ${raw}`);
      }
      if (!["http:", "https:", "file:"].includes(url.protocol)) throw new Error(`unsupported URL scheme ${url.protocol} (http, https or file only)`);
      const chrome = chromeHeadlessShell();
      if (!chrome) throw new Error("the pinned chrome-headless-shell is missing; run `shorts-studio doctor --setup`");
      const name = (args.str("name") ?? `${url.hostname || "local"}-${Date.now().toString(36)}`).replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
      const w = Math.max(360, Math.min(2560, args.num("width") ?? 1280));
      const h = Math.max(640, Math.min(8000, args.num("height") ?? 2400));
      const dir = join(p.dir, "assets", "captures");
      mkdirSync(dir, { recursive: true });
      const out = join(dir, `${name}.png`);
      await run([chrome, "--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", `--window-size=${w},${h}`, "--virtual-time-budget=8000", `--screenshot=${out}`, url.href], { timeoutMs: 120_000 });
      if (!existsSync(out) || statSync(out).size < 1000) throw new Error(`capture of ${url.href} produced no image`);
      const size = imageSize(out);
      const record = { url: url.href, capturedAt: nowIso(), file: out, width: size.w, height: size.h, sha256: createHash("sha256").update(readFileSync(out)).digest("hex"), tool: `chrome-headless-shell ${CHROME_HEADLESS_SHELL}` };
      writeJson(join(dir, `${name}.json`), record);
      return {
        json: record,
        human: `captured ${url.href} → ${out} (${size.w}×${size.h})\nuse it as {"kind":"source-page","src":"${out}"} with sources: [{"url":"${url.href}","kind":"capture","disclosed":true}]`,
      };
    },
  },
};
