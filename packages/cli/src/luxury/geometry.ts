import type { Box, FaceTrack, Flicks, TimeMap } from "../../../core/src/index.ts";

/** Preset camera-card geometry (canvas px) and reference 16:9 placement. */
export const CARD = { x: -65, y: 1200, w: 1210, h: 864, radius: 200 } as const;
export const REF_16x9_WIDTH = 1890;
/** Head top lands just under the split caption zone (y 941–1114). */
export const HEAD_TOP_TARGET = 1126;
export const FEATHER_PX = 40;

export interface FaceStats {
  box: Box;
  eyeY: number;
  samples: number;
}

/** Median face (largest track per instant) over the source frames the edit presents. */
export function presentedFace(tracks: FaceTrack[], map: TimeMap, sourceId: string, range?: { start: Flicks; end: Flicks }): FaceStats | null {
  const xs: Array<{ box: Box; eye: number }> = [];
  for (const tr of tracks) {
    for (const s of tr.samples) {
      const outs = map.srcToOut("video", sourceId, s.t);
      if (!outs.length || (range && !outs.some((o) => o >= range.start && o < range.end))) continue;
      xs.push({ box: s.box, eye: s.landmarks ? (s.landmarks[1]! + s.landmarks[3]!) / 2 : s.box.y + s.box.h * 0.4 });
    }
  }
  if (xs.length === 0) return null;
  // Keep the dominant (largest) faces only.
  const areas = xs.map((x) => x.box.w * x.box.h).sort((a, b) => b - a);
  const cutoff = areas[Math.floor(areas.length * 0.5)]! * 0.5;
  const main = xs.filter((x) => x.box.w * x.box.h >= cutoff);
  const med = (vals: number[]) => [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)]!;
  return { box: { x: med(main.map((m) => m.box.x)), y: med(main.map((m) => m.box.y)), w: med(main.map((m) => m.box.w)), h: med(main.map((m) => m.box.h)) }, eyeY: med(main.map((m) => m.eye)), samples: main.length };
}

/** Cover-fitted 9:16 crop, static, with the face centred horizontally. */
export function fullCameraCrop(frame: { width: number; height: number }, face: FaceStats | null): Box {
  const aspect = 1080 / 1920;
  if (frame.width / frame.height > aspect) {
    const w = Math.round(frame.height * aspect);
    const cx = face ? face.box.x + face.box.w / 2 : frame.width / 2;
    const x = Math.min(Math.max(0, Math.round(cx - w / 2)), frame.width - w);
    return { x, y: 0, w, h: frame.height };
  }
  const h = Math.round(frame.width / aspect);
  const cy = face ? face.eyeY + h * 0.14 : frame.height / 2;
  const y = Math.min(Math.max(0, Math.round(cy - h / 2)), frame.height - h);
  return { x: 0, y, w: frame.width, h };
}

export interface SplitGeometry {
  /** Source → canvas: canvas = (X, Y) + s × source. */
  s: number;
  X: number;
  Y: number;
  card: { region: { x: number; y: number; w: number; h: number }; srcBox: Box };
  head: { region: { x: number; y: number; w: number; h: number }; srcBox: Box } | null;
  headTopCanvas: number;
  eyeCanvasY: number;
  notes: string[];
  contained: boolean;
}

const even = (n: number) => Math.round(n / 2) * 2;

/**
 * One transform shared by the card footage and the head matte. Starts from the
 * reference placement (16:9 → 1890 px wide) and moves it so the face is centred
 * and the head top rises just above the card, while the footage still covers the card.
 */
export function splitGeometry(frame: { width: number; height: number }, face: FaceStats | null): SplitGeometry {
  const notes: string[] = [];
  const W = frame.width;
  const H = frame.height;
  const s = W / H >= 1.5 ? REF_16x9_WIDTH / W : Math.max(1250 / W, (1920 - CARD.y) / (H * 0.6));
  const faceCx = face ? face.box.x + face.box.w / 2 : W / 2;
  const headTop = face ? Math.max(0, face.box.y - 0.3 * face.box.h) : H * 0.1;
  const cardRight = CARD.x + CARD.w;
  let X = 540 - s * faceCx;
  X = Math.min(Math.max(X, cardRight - s * W), CARD.x);
  let Y = HEAD_TOP_TARGET - s * headTop;
  const minY = 1920 - s * H;
  if (Y < minY) {
    notes.push(`placement lowered to cover the card bottom (head target ${HEAD_TOP_TARGET} not reachable)`);
    Y = minY;
  }
  if (Y > CARD.y) {
    notes.push("source cannot cover the card top at this scale; head stays inside the card");
    Y = CARD.y;
  }
  const headTopCanvas = Y + s * headTop;
  const eyeCanvasY = Y + s * (face?.eyeY ?? H * 0.4);
  const cardRegion = { x: 0, y: CARD.y, w: 1080, h: 1920 - CARD.y };
  const cardSrc: Box = { x: (cardRegion.x - X) / s, y: (cardRegion.y - Y) / s, w: cardRegion.w / s, h: cardRegion.h / s };
  let head: SplitGeometry["head"] = null;
  let contained = false;
  if (!face) {
    contained = true;
    notes.push("no face evidence — contained camera card (no head break-out)");
  } else if (headTopCanvas >= CARD.y - 12) {
    contained = true;
    notes.push(`head top lands at y=${Math.round(headTopCanvas)} (card top ${CARD.y}) — contained camera card`);
  } else {
    const y0 = Math.max(even(Math.ceil(Y) + 1), even(headTopCanvas - 36));
    // The head stays fully opaque down to the card top and fades out inside the card,
    // where the card shows the identical frame — so the join is invisible (no ghosting).
    const y1 = CARD.y + FEATHER_PX;
    const region = { x: 0, y: y0, w: 1080, h: y1 - y0 };
    head = { region, srcBox: { x: (0 - X) / s, y: (y0 - Y) / s, w: 1080 / s, h: region.h / s } };
  }
  if (eyeCanvasY > 1700) notes.push(`eyes at y=${Math.round(eyeCanvasY)} sit low in the card`);
  return { s, X, Y, card: { region: cardRegion, srcBox: cardSrc }, head, headTopCanvas, eyeCanvasY, notes, contained };
}
