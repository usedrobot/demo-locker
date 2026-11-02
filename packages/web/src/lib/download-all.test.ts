// @vitest-environment happy-dom
//
// "Download all" zips a playlist's ORIGINALS in the browser, in playlist order.
// Built client-side on purpose: zipping on a Worker spends CPU on every byte,
// and the browser already has the per-track download route.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Track } from "./api";

vi.mock("./api", () => ({
  tracks: { downloadUrl: (id: string) => `https://locker.test/tracks/${id}/download?token=x` },
}));

import { zipEntryName, buildPlaylistZip, zipFileName } from "./download-all";

const t = (id: string, title: string) =>
  ({ id, title, hasStream: true, uploadedAt: "2026-10-01T00:00:00Z" }) as unknown as Track;

describe("zipEntryName", () => {
  it("numbers by playlist position and takes the extension from the content type", () => {
    expect(zipEntryName(0, 5, "Alpha Ridge", "audio/wav", null)).toBe("01 - Alpha Ridge.wav");
    expect(zipEntryName(4, 5, "Ember Tide", "audio/mpeg", null)).toBe("05 - Ember Tide.mp3");
    expect(zipEntryName(0, 1, "Take", "audio/flac", null)).toBe("01 - Take.flac");
    expect(zipEntryName(0, 1, "Take", "audio/x-aiff", null)).toBe("01 - Take.aif");
  });

  it("pads to three digits once a playlist reaches 100 tracks, so names still sort", () => {
    expect(zipEntryName(6, 120, "Seven", "audio/wav", null)).toBe("007 - Seven.wav");
  });

  it("falls back to the filename's extension when the type is not an audio type", () => {
    expect(
      zipEntryName(0, 1, "Mix", "application/octet-stream", `attachment; filename="mix_v3.AIFF"`),
    ).toBe("01 - Mix.aiff");
    expect(zipEntryName(0, 1, "Mix", "application/octet-stream", null)).toBe("01 - Mix");
  });

  it("replaces characters that would make a path or break on Windows", () => {
    expect(zipEntryName(0, 1, "AC/DC: Live? <b>", "audio/wav", null)).toBe("01 - AC-DC- Live- -b-.wav");
    expect(zipEntryName(0, 1, "../../etc", "audio/wav", null)).toBe("01 - ..-..-etc.wav");
    expect(zipEntryName(0, 1, "   ", "audio/wav", null)).toBe("01 - track.wav");
  });
});

describe("zipFileName", () => {
  it("names the zip after the playlist", () => {
    expect(zipFileName("Slack Tide")).toBe("Slack Tide.zip");
    expect(zipFileName("a/b")).toBe("a-b.zip");
    expect(zipFileName("")).toBe("playlist.zip");
  });
});

describe("buildPlaylistZip", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  function audio(body: string, type = "audio/wav") {
    return new Response(body, { status: 200, headers: { "content-type": type } });
  }

  it("fetches each original once, in playlist order, one at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    fetchMock.mockImplementation(async (url: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return audio(`bytes of ${url}`);
    });
    const blob = await buildPlaylistZip([t("b", "Bee"), t("a", "Ay")]);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://locker.test/tracks/b/download?token=x",
      "https://locker.test/tracks/a/download?token=x",
    ]);
    expect(maxInFlight, "parallel fetches would hold every file in memory at once").toBe(1);
    const text = new TextDecoder().decode(await blob.arrayBuffer());
    expect(text).toContain("01 - Bee.wav");
    expect(text).toContain("02 - Ay.wav");
    expect(text.indexOf("01 - Bee.wav")).toBeLessThan(text.indexOf("02 - Ay.wav"));
    // Stored, not deflated: the audio bytes are in the archive verbatim.
    expect(text).toContain("bytes of https://locker.test/tracks/b/download?token=x");
  });

  it("reports progress as each track starts", async () => {
    fetchMock.mockImplementation(async () => audio("x"));
    const seen: string[] = [];
    await buildPlaylistZip([t("a", "A"), t("b", "B")], (done, total) => seen.push(`${done}/${total}`));
    expect(seen).toEqual(["1/2", "2/2"]);
  });

  it("fails with the track's name when one original cannot be fetched", async () => {
    fetchMock
      .mockResolvedValueOnce(audio("x"))
      .mockResolvedValueOnce(new Response("{}", { status: 404 }));
    await expect(buildPlaylistZip([t("a", "Fine"), t("b", "Gone Missing")])).rejects.toThrow(
      /Gone Missing/,
    );
  });
});
