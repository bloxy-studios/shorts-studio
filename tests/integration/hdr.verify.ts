/**
 * HDR → SDR verification (docs/COLOR.md): synthetic 10-bit PQ and HLG clips with known
 * patch luminances go through the production tone-mapping chain; measured SDR values are
 * compared with the LUT's analytic expectation and with a naive (washed-out) conversion.
 *   SS_DEV=1 bun tests/integration/hdr.verify.ts [outDir]
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { hdrLut, hdrToSdrFilter, type HdrKind } from "../../packages/adapters/src/media/color.ts";
import { probeMedia } from "../../packages/adapters/src/media/probe.ts";
import { py } from "../../packages/adapters/src/python.ts";
import { run } from "../../packages/adapters/src/proc.ts";
import { tool } from "../../packages/adapters/src/tools.ts";

const out = process.argv[2] ?? "/tmp/ss-hdr";
mkdirSync(out, { recursive: true });

async function rgbAt(video: string, xs: number[], y: number): Promise<number[][]> {
  const r = await run([tool("ffmpeg"), "-v", "error", "-i", video, "-vf", "select=eq(n\\,0),scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"], { binary: true, timeoutMs: 120_000 });
  const buf = r.stdoutBuffer!;
  return xs.map((x) => [0, 1, 2].map((k) => buf[(y * 640 + x) * 3 + k]!));
}

let failures = 0;
for (const kind of ["pq", "hlg"] as HdrKind[]) {
  const clip = join(out, `${kind}.mov`);
  const t = await py<{ patchNits: number[]; patchX: number[]; redX: number }>("color.hdr_testclip", { kind, out: clip });
  const probe = await probeMedia(clip);
  const lut = await hdrLut(kind);
  const lutInfo = await py<{ sdrCodeForNits: Record<string, number> }>("color.hdr_lut", { kind, out: join(out, `${kind}.cube`), size: 33 });
  const mapped = join(out, `${kind}-sdr.mp4`);
  const naive = join(out, `${kind}-naive.mp4`);
  await run([tool("ffmpeg"), "-v", "error", "-y", "-i", clip, "-vf", `${hdrToSdrFilter(lut)},format=yuv420p`, "-c:v", "libx264", "-crf", "8", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", mapped], { timeoutMs: 120_000 });
  await run([tool("ffmpeg"), "-v", "error", "-y", "-i", clip, "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "libx264", "-crf", "8", naive], { timeoutMs: 120_000 });
  const xs = [...t.patchX, t.redX];
  const got = await rgbAt(mapped, xs, 180);
  const bad = await rgbAt(naive, xs, 180);
  console.log(`\n${kind.toUpperCase()} (probe: isHDR=${probe.video?.isHDR} ${probe.video?.hdrKind})`);
  t.patchNits.forEach((nits, i) => {
    const code = lutInfo.sdrCodeForNits[String(nits)] ?? lutInfo.sdrCodeForNits[nits.toFixed(1)];
    const expected = Math.round(code! * 255);
    const m = got[i]!;
    const ok = m.every((v) => Math.abs(v - expected) <= 4);
    if (!ok) failures++;
    console.log(`  ${String(nits).padStart(6)} nits → SDR ${m.join(",")} (expected ≈${expected}) ${ok ? "✓" : "✗"} | naive ${bad[i]!.join(",")}`);
  });
  const red = got[4]!;
  const redOk = red[0]! > 2 * red[1]! && red[0]! > 2 * red[2]!;
  if (!redOk) failures++;
  console.log(`  BT.2020 red → SDR ${red.join(",")} ${redOk ? "✓ hue kept" : "✗"} | naive ${bad[4]!.join(",")}`);
}
if (failures) {
  console.error(`${failures} HDR check(s) failed`);
  process.exit(1);
}
console.log("\nHDR → SDR mapping verified");
