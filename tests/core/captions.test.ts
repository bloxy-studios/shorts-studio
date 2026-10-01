import { describe, expect, test } from "bun:test";
import {
  TimeMap,
  applyEmphasis,
  buildTimeMapPieces,
  flicksPerFrame,
  groupCaptions,
  isFrameAligned,
  retimeWords,
  toSrt,
  toVtt,
  toWordsJson,
  type CaptionTrack,
  type GroupingParams,
} from "../../packages/core/src/index.ts";
import { FPS60, MS, S, makePlan, sentence, word } from "./helpers.ts";

const PHRASE: GroupingParams = {
  minWords: 2,
  maxWords: 5,
  maxCharsPerLine: 22,
  maxLines: 2,
  pauseSplitMs: 350,
  minChunkMs: 400,
  maxChunkMs: 2600,
  holdAfterMs: 250,
  maxReadingCps: 25,
};

describe("retiming captions through the edit", () => {
  test("words after a cut move to their output time; removed words drop out", () => {
    // Source: words at 10.0s.. and 30.0s..; edit keeps [10,12) then [30,33) with a 50 ms J-cut.
    const plan = makePlan([
      [10, 2],
      [30, 3],
    ], { jcutLeadMs: 50 });
    const map = new TimeMap(buildTimeMapPieces(plan.segments));
    const words = [
      word("w1", "Hello", 10.2, 10.5),
      word("w2", "there.", 10.55, 10.9),
      word("w3", "Skipped", 20.0, 20.4),
      word("w4", "Next", 30.1, 30.4),
      word("w5", "point", 30.45, 30.8),
    ];
    const { words: out, dropped } = retimeWords(words, map, "cam");
    expect(dropped.map((d) => d.sourceWordId)).toEqual(["w3"]);
    const byId = new Map(out.map((w) => [w.sourceWordId, w]));
    expect(byId.get("w1")!.outStart).toBe(S(0.2));
    expect(byId.get("w4")!.outStart).toBe(S(2.1)); // 30.1 - 30.0 + 2.0
    expect(byId.get("w5")!.outEnd).toBe(S(2.8));
    expect(out.map((w) => w.id)).toEqual(["fw0001", "fw0002", "fw0003", "fw0004"]);
  });

  test("a word mostly cut by a boundary is dropped and reported, not shown", () => {
    const plan = makePlan([[10, 1]]);
    const map = new TimeMap(buildTimeMapPieces(plan.segments));
    const { words, dropped } = retimeWords([word("w1", "cutoff", 10.9, 11.4)], map, "cam");
    expect(words).toHaveLength(0);
    expect(dropped[0]!.reason).toBe("mostly-cut");
  });
});

describe("caption grouping", () => {
  const fps = FPS60;
  const frame = flicksPerFrame(fps);

  function finals(texts: string, t0 = 0.5) {
    const plan = makePlan([[0, 20]]);
    const map = new TimeMap(buildTimeMapPieces(plan.segments));
    return retimeWords(sentence("w", texts, t0), map, "cam").words;
  }

  test("chunks are frame-aligned, ordered, non-overlapping and end before END", () => {
    const words = finals("So the main reason we built this is speed. Everything else came later, honestly.");
    const { chunks } = groupCaptions(words, PHRASE, { fps, minStart: frame, end: S(20) });
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      expect(isFrameAligned(c.outStart, fps)).toBe(true);
      expect(isFrameAligned(c.outEnd, fps)).toBe(true);
      expect(c.outEnd).toBeGreaterThan(c.outStart);
      if (i > 0) expect(c.outStart).toBeGreaterThanOrEqual(chunks[i - 1]!.outEnd);
      expect(c.words.length).toBeLessThanOrEqual(PHRASE.maxWords);
    }
  });

  test("sentence punctuation always ends a chunk", () => {
    const words = finals("It works. Really well.");
    const { chunks } = groupCaptions(words, PHRASE, { fps, minStart: 0, end: S(20) });
    expect(chunks.map((c) => c.words.map((w) => w.text).join(" "))).toEqual(["It works.", "Really well."]);
  });

  test("a pause splits chunks and a caption never lingers past its words + hold", () => {
    const words = [word("w1", "First", 1.0, 1.3), word("w2", "bit", 1.35, 1.6), word("w3", "later", 4.0, 4.4)];
    const plan = makePlan([[0, 10]]);
    const out = retimeWords(words, new TimeMap(buildTimeMapPieces(plan.segments)), "cam").words;
    const { chunks } = groupCaptions(out, PHRASE, { fps, minStart: 0, end: S(10) });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.outEnd).toBeLessThanOrEqual(S(1.6) + MS(PHRASE.holdAfterMs) + frame);
    expect(chunks[1]!.outStart).toBe(S(4.0));
  });

  test("captions start no earlier than the first frame after frame zero", () => {
    const words = [word("w1", "Instant", 0.0, 0.3), word("w2", "start", 0.32, 0.6)];
    const plan = makePlan([[0, 5]]);
    const out = retimeWords(words, new TimeMap(buildTimeMapPieces(plan.segments)), "cam").words;
    const { chunks, issues } = groupCaptions(out, PHRASE, { fps, minStart: frame, end: S(5) });
    expect(chunks[0]!.outStart).toBe(frame);
    expect(issues.some((i) => i.kind === "clamped-start")).toBe(true);
  });

  test("function words are not stranded at the end of a chunk", () => {
    const params = { ...PHRASE, maxWords: 3 };
    const words = finals("we are going to the store now");
    const { chunks } = groupCaptions(words, params, { fps, minStart: 0, end: S(20) });
    for (const c of chunks.slice(0, -1)) {
      const last = c.words[c.words.length - 1]!.text;
      expect(["to", "the", "a"]).not.toContain(last);
    }
  });

  test("two-line balancing keeps each line within the width budget", () => {
    const params = { ...PHRASE, maxWords: 6, maxCharsPerLine: 14 };
    const words = finals("remarkable engineering decisions matter enormously");
    const { chunks } = groupCaptions(words, params, { fps, minStart: 0, end: S(20) });
    for (const c of chunks) {
      const byId = new Map(c.words.map((w) => [w.id, w.display]));
      for (const line of c.lines) {
        const text = line.map((id) => byId.get(id)).join(" ");
        if (line.length > 1) expect(text.length).toBeLessThanOrEqual(14);
      }
    }
  });
});

describe("semantic emphasis", () => {
  const fps = FPS60;
  const frame = flicksPerFrame(fps);
  const params = { ...PHRASE, minWords: 1, maxWords: 3 };

  function chunksFor(text: string, keepTogether: string[] = []) {
    const plan = makePlan([[0, 30]]);
    const out = retimeWords(sentence("w", text, 0.5), new TimeMap(buildTimeMapPieces(plan.segments)), "cam").words;
    return groupCaptions(out, params, { fps, minStart: frame, end: S(30), keepTogether }).chunks;
  }

  test("cadence mode never highlights consecutive chunks or function words", () => {
    const chunks = chunksFor(
      "Claude Code writes the tests first then implements the feature and the reviewer checks everything before merging to production today",
    );
    const { chunks: out, decisions } = applyEmphasis(chunks, {
      mode: "cadence",
      maxWordsPerChunk: 2,
      cadence: { minNormalChunks: 2, maxNormalChunks: 3, maxWords: 2 },
    });
    expect(decisions.length).toBeGreaterThan(0);
    const highlighted = out.map((c) => c.words.some((w) => w.emphasis === "highlight"));
    for (let i = 1; i < highlighted.length; i++) expect(highlighted[i] && highlighted[i - 1]).toBe(false);
    expect(highlighted.slice(0, 2)).toEqual([false, false]);
    for (const c of out) for (const w of c.words) if (w.emphasis === "highlight") expect(["the", "and", "to", "then"]).not.toContain(w.text.toLowerCase());
  });

  test("keyword-only emphasis restricts highlights to product names", () => {
    const chunks = chunksFor("I opened Claude Code and the terminal showed a beautiful diff instantly", ["Claude Code"]);
    const withName = chunks.find((c) => c.words.some((w) => w.text === "Claude"))!;
    expect(withName.words.map((w) => w.text)).toContain("Code");
    const { chunks: out } = applyEmphasis(chunks, { mode: "semantic", maxWordsPerChunk: 2, keywords: ["Claude Code"], onlyKeywords: true });
    const hl = out.flatMap((c) => c.words.filter((w) => w.emphasis === "highlight").map((w) => w.text));
    expect(hl).toEqual(["Claude", "Code"]);
  });

  test("protected phrases are never split across chunks", () => {
    const chunks = chunksFor("we shipped it with Claude Code yesterday", ["Claude Code"]);
    const idx = chunks.findIndex((c) => c.words.some((w) => w.text === "Claude"));
    expect(chunks[idx]!.words.map((w) => w.text)).toContain("Code");
  });
});

describe("subtitle exports", () => {
  test("SRT, VTT and word JSON reflect final timings", () => {
    const track: CaptionTrack = {
      styleId: "clean",
      styleVersion: "1",
      overrides: {},
      language: "en",
      minStartFlicks: 0,
      notes: [],
      delivery: { burnIn: true, srt: true, vtt: true, wordsJson: true },
      chunks: [
        {
          id: "cc001",
          outStart: S(1),
          outEnd: S(2.5),
          lines: [["fw0001", "fw0002"]],
          words: [
            { id: "fw0001", sourceWordId: "w1", text: "Hello", display: "Hello", outStart: S(1), outEnd: S(1.4), emphasis: "none", uncertain: false },
            { id: "fw0002", sourceWordId: "w2", text: "world", display: "world", outStart: S(1.5), outEnd: S(2), emphasis: "highlight", uncertain: false },
          ],
        },
      ],
    };
    expect(toSrt(track)).toBe("1\n00:00:01,000 --> 00:00:02,500\nHello world\n");
    expect(toVtt(track)).toContain("00:00:01.000 --> 00:00:02.500\nHello world");
    const json = toWordsJson(track);
    expect(json.words[1]).toMatchObject({ text: "world", start: 1500, end: 2000, emphasis: "highlight", sourceWordId: "w2" });
  });
});

describe("semantic emphasis density", () => {
  const fps = FPS60;
  const frame = flicksPerFrame(fps);
  test("caps highlights, keeps them apart, and never repeats a highlighted word", () => {
    const plan = makePlan([[0, 60]]);
    const text = "Apollo had a twin sister and Apollo's twin sister was named Artemis and Artemis happens to be the goddess of the moon so fifty years after Apollo we have a new program named after Apollo's twin sister";
    const out = retimeWords(sentence("w", text, 0.5), new TimeMap(buildTimeMapPieces(plan.segments)), "cam").words;
    const chunks = groupCaptions(out, { ...PHRASE, minWords: 1, maxWords: 3 }, { fps, minStart: frame, end: S(60) }).chunks;
    const { chunks: emph, decisions } = applyEmphasis(chunks, { mode: "semantic", maxWordsPerChunk: 1 });
    const highlighted = emph.map((c) => c.words.some((w) => w.emphasis === "highlight"));
    expect(decisions.length).toBeLessThanOrEqual(Math.floor(chunks.length * 0.3));
    for (let i = 1; i < highlighted.length; i++) expect(highlighted[i] && highlighted[i - 1]).toBe(false);
    const words = emph.flatMap((c) => c.words.filter((w) => w.emphasis === "highlight").map((w) => w.text.toLowerCase().replace(/[^a-z']/g, "")));
    expect(new Set(words).size).toBe(words.length);
  });
});
