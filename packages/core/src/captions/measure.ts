/** Text width estimation from bundled glyph advance tables (assets/fonts/metrics.json). */

export interface FaceMetrics {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  advances: Record<string, number>;
  fallbackAdvance: number;
  space: number;
}

export type MetricsTable = Record<string, FaceMetrics>;

export interface TextFace {
  family: string;
  weight: number;
  style: "normal" | "italic";
  sizePx: number;
  letterSpacingEm?: number;
  /** Visible stroke width outside the glyph (paint-order: stroke fill). */
  strokePx?: number;
  /** Uppercase transform applied before measuring. */
  upper?: boolean;
  /** CSS word-spacing added to every space. */
  wordSpacingPx?: number;
}

export function faceKey(family: string, weight: number, style: string): string {
  return `${family}|${weight}|${style}`;
}

/** Finds the face, falling back to the nearest weight of the same family/style. */
export function resolveFace(table: MetricsTable, family: string, weight: number, style: string): FaceMetrics | null {
  const exact = table[faceKey(family, weight, style)];
  if (exact) return exact;
  const candidates = Object.keys(table)
    .map((k) => k.split("|"))
    .filter(([f, , s]) => f === family && s === style)
    .sort((a, b) => Math.abs(Number(a[1]) - weight) - Math.abs(Number(b[1]) - weight));
  const best = candidates[0];
  return best ? (table[best.join("|")] ?? null) : null;
}

/**
 * Width in px. Missing glyphs use the face's average advance; unknown faces use
 * 0.56 em per character. A 3% margin covers kerning/hinting differences.
 */
export function measureText(table: MetricsTable, face: TextFace, text: string): number {
  const t = face.upper ? text.toUpperCase() : text;
  const m = resolveFace(table, face.family, face.weight, face.style);
  const size = face.sizePx;
  let units = 0;
  if (m) {
    for (const ch of t) units += m.advances[ch] ?? m.fallbackAdvance;
    units /= m.unitsPerEm;
  } else {
    units = [...t].length * 0.56;
  }
  const spacing = (face.letterSpacingEm ?? 0) * size * Math.max(0, [...t].length - 1);
  const stroke = 2 * (face.strokePx ?? 0);
  const spaces = (t.match(/ /g) ?? []).length;
  return (units * size + spacing) * 1.03 + stroke + spaces * (face.wordSpacingPx ?? 0);
}

export function makeMeasurer(table: MetricsTable, face: TextFace): (text: string) => number {
  return (text) => measureText(table, face, text);
}
