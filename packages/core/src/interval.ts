import type { Flicks } from "./time.ts";

/** Half-open interval [start, end) in flicks. */
export interface Interval {
  start: Flicks;
  end: Flicks;
}

export interface LabeledInterval extends Interval {
  id: string;
}

export function duration(i: Interval): Flicks {
  return i.end - i.start;
}

export function isValidInterval(i: Interval, allowEmpty = false): boolean {
  if (!Number.isSafeInteger(i.start) || !Number.isSafeInteger(i.end)) return false;
  return allowEmpty ? i.end >= i.start : i.end > i.start;
}

export function contains(i: Interval, t: Flicks): boolean {
  return t >= i.start && t < i.end;
}

export function containsInterval(outer: Interval, inner: Interval): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function intersect(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

export function overlapAmount(a: Interval, b: Interval): Flicks {
  const i = intersect(a, b);
  return i ? duration(i) : 0;
}

/** Intersection-over-union for candidate de-duplication. */
export function iou(a: Interval, b: Interval): number {
  const inter = overlapAmount(a, b);
  if (inter === 0) return 0;
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  return inter / union;
}

export function shift(i: Interval, by: Flicks): Interval {
  return { start: i.start + by, end: i.end + by };
}

export type TilingIssueKind = "gap" | "overlap" | "out-of-range" | "invalid" | "empty";

export interface TilingIssue {
  kind: TilingIssueKind;
  at: Flicks;
  amount: Flicks;
  ids: string[];
  message: string;
}

/**
 * Verifies that `items` tile `total` exactly: sorted coverage from total.start to
 * total.end with no gaps, overlaps, or empty/invalid members.
 */
export function checkTiling(items: LabeledInterval[], total: Interval): TilingIssue[] {
  const issues: TilingIssue[] = [];
  if (items.length === 0) {
    issues.push({ kind: "empty", at: total.start, amount: duration(total), ids: [], message: "no intervals" });
    return issues;
  }
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = total.start;
  let prevId: string | null = null;
  for (const item of sorted) {
    if (!isValidInterval(item)) {
      issues.push({ kind: "invalid", at: item.start, amount: 0, ids: [item.id], message: `${item.id} is empty or non-integer` });
      continue;
    }
    if (item.start < total.start || item.end > total.end) {
      issues.push({
        kind: "out-of-range",
        at: item.start,
        amount: Math.max(total.start - item.start, item.end - total.end),
        ids: [item.id],
        message: `${item.id} extends outside [${total.start}, ${total.end})`,
      });
    }
    if (item.start > cursor) {
      issues.push({
        kind: "gap",
        at: cursor,
        amount: item.start - cursor,
        ids: prevId ? [prevId, item.id] : [item.id],
        message: `gap of ${item.start - cursor} flicks before ${item.id}`,
      });
    } else if (item.start < cursor) {
      issues.push({
        kind: "overlap",
        at: item.start,
        amount: cursor - item.start,
        ids: prevId ? [prevId, item.id] : [item.id],
        message: `${item.id} overlaps previous interval by ${cursor - item.start} flicks`,
      });
    }
    cursor = Math.max(cursor, item.end);
    prevId = item.id;
  }
  if (cursor < total.end) {
    issues.push({
      kind: "gap",
      at: cursor,
      amount: total.end - cursor,
      ids: prevId ? [prevId] : [],
      message: `timeline not covered after ${cursor}`,
    });
  }
  return issues;
}

/** Merges touching/overlapping intervals; input need not be sorted. */
export function mergeIntervals(items: Interval[], joinGap: Flicks = 0): Interval[] {
  const sorted = [...items].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end + joinGap) {
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, i.end) };
    } else {
      out.push({ start: i.start, end: i.end });
    }
  }
  return out;
}

/** Complement of `items` within `total` (e.g. silences from speech regions). */
export function complement(items: Interval[], total: Interval): Interval[] {
  const merged = mergeIntervals(items);
  const out: Interval[] = [];
  let cursor = total.start;
  for (const i of merged) {
    if (i.end <= total.start || i.start >= total.end) continue;
    if (i.start > cursor) out.push({ start: cursor, end: Math.min(i.start, total.end) });
    cursor = Math.max(cursor, i.end);
  }
  if (cursor < total.end) out.push({ start: cursor, end: total.end });
  return out;
}
