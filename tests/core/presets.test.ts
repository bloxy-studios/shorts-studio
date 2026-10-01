import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listIds, loadCaptionStyle, loadPreset } from "../../packages/adapters/src/presets.ts";
import { paths } from "../../packages/adapters/src/env.ts";

describe("shipped presets", () => {
  test("all six editorial presets validate", () => {
    const ids = listIds("editorial");
    expect(ids).toEqual(["clean-podcast", "comedy-reactions", "custom-brand", "educational-screen", "luxury-tech", "social-dynamic"]);
    for (const id of ids) expect(loadPreset(id).id).toBe(id);
  });

  test("six distinct caption styles validate and reference bundled fonts", () => {
    const ids = listIds("captions");
    expect(ids).toEqual(["bold-pop", "clean", "editorial", "luxury-tech", "playful", "word-highlight"]);
    const fontsDir = paths().fontsDir;
    for (const id of ids) {
      const style = loadCaptionStyle(id);
      for (const f of style.fonts) expect(existsSync(join(fontsDir, f.file))).toBe(true);
    }
  });

  test("Luxury Tech forbids footage motion and requires 60 fps; Social Dynamic permits punch-ins", () => {
    const lux = loadPreset("luxury-tech");
    expect(lux.framing.cameraFootageMotion).toBe("none");
    expect(lux.framing.punchIn).toBeNull();
    expect(lux.output.fps).toEqual({ num: 60, den: 1 });
    expect(lux.audio.music.ducking).toBe(false);
    expect((lux.graphics.tokens as { ink?: string }).ink).toBe("#111111");
    const social = loadPreset("social-dynamic");
    expect(social.framing.punchIn).toEqual({ min: 1.05, max: 1.15 });
  });

  test("every preset's caption zones and default style are valid", () => {
    for (const id of listIds("editorial")) {
      const p = loadPreset(id);
      expect(p.captions.allowedStyleIds).toContain(p.captions.defaultStyleId);
      for (const z of Object.values(p.captions.zones)) expect(z.y1).toBeGreaterThan(z.y0);
      const w = p.scoring.weights;
      expect(w.hook + w.payoff + w.standalone + w.emotion + w.delivery + w.fit).toBe(100);
    }
  });
});
