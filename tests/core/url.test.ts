import { describe, expect, test } from "bun:test";
import { diagnoseYtDlp, resolveUrl } from "../../packages/adapters/src/acquire/url.ts";
import { secondsToFlicks } from "../../packages/core/src/index.ts";

describe("YouTube URL normalization", () => {
  test("normalizes common single-video variants", () => {
    for (const u of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ?si=abc",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ]) {
      const r = resolveUrl(u);
      expect(r.kind).toBe("youtube-video");
      expect(r.normalized).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    }
  });

  test("a start time is a hint, not a trim", () => {
    const r = resolveUrl("https://youtu.be/dQw4w9WgXcQ?t=1m30s");
    expect(r.startHint).toBe(secondsToFlicks(90));
    expect(r.notes.join(" ")).toContain("full video is analyzed");
    expect(resolveUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42").startHint).toBe(secondsToFlicks(42));
  });

  test("distinguishes playlists from a video inside a playlist", () => {
    expect(resolveUrl("https://www.youtube.com/playlist?list=PL123abc").kind).toBe("youtube-playlist");
    const v = resolveUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123abc");
    expect(v.kind).toBe("youtube-video");
    expect(v.playlistId).toBe("PL123abc");
  });

  test("non-YouTube URLs pass through", () => {
    expect(resolveUrl("https://example.com/video.mp4").kind).toBe("url");
    expect(() => resolveUrl("not a url")).toThrow();
  });
});

describe("acquisition failure diagnosis", () => {
  test("classifies yt-dlp errors", () => {
    expect(diagnoseYtDlp("ERROR: [youtube] x: Sign in to confirm you’re not a bot")).toBe("sign-in-required");
    expect(diagnoseYtDlp("ERROR: [youtube] x: Private video. Sign in if you've been granted access")).toBe("private");
    expect(diagnoseYtDlp("ERROR: [youtube] x: Video unavailable")).toBe("unavailable");
    expect(diagnoseYtDlp("WARNING: nsig extraction failed: Some formats may be missing")).toBe("extractor-outdated");
    expect(diagnoseYtDlp("ERROR: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided>  getaddrinfo failed")).toBe("network");
    expect(diagnoseYtDlp("ERROR: [youtube] x: The uploader has not made this video available in your country")).toBe("geo-restricted");
    // Regression: a 429 on optional auto-captions used to surface as "unknown".
    expect(diagnoseYtDlp("ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests")).toBe("network");
  });
});
