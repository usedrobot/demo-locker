// @vitest-environment happy-dom
//
// Plays are reported from the client, once per track start. The stream route
// cannot count (Range requests), and reporting on every `play` event would
// count each pause/resume. So the report waits for the first `playing` of a
// freshly loaded source and fires once per load.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./api", () => ({
  tracks: {
    streamUrl: (id: string) => `/tracks/${id}/stream`,
    recordPlay: vi.fn(async () => ({ ok: true })),
  },
}));

import { tracks as tracksApi, type Track } from "./api";
import { player, getAudioElement } from "./audio";

const recordPlay = vi.mocked(tracksApi.recordPlay);

function track(id: string): Track {
  return {
    id,
    title: id,
    hasStream: true,
    waveformData: null,
    duration: 10,
    uploadedAt: "2026-01-01T00:00:00Z",
    uploadedByMe: true,
    uploadedByName: null,
  };
}

function playing() {
  getAudioElement().dispatchEvent(new Event("playing"));
}

beforeEach(() => {
  recordPlay.mockClear();
  player.clear();
  localStorage.clear();
});

describe("play reporting", () => {
  it("reports once when a freshly loaded track starts playing, with the queue's playlist", () => {
    player.setPlaylist([track("a"), track("b")], "pl-1");
    player.play("a");
    // happy-dom fires `playing` from play() itself; the explicit dispatch
    // stands in for the real browser's event and must not double count.
    playing();
    expect(recordPlay).toHaveBeenCalledTimes(1);
    expect(recordPlay).toHaveBeenCalledWith("a", "pl-1");
  });

  it("does not report again on resume after a pause", () => {
    player.setPlaylist([track("a")], null);
    player.play("a");
    playing();
    player.pause();
    player.play();
    playing();
    expect(recordPlay).toHaveBeenCalledTimes(1);
    expect(recordPlay).toHaveBeenCalledWith("a", null);
  });

  it("reports each track in the queue as it starts", () => {
    player.setPlaylist([track("a"), track("b")], "pl-2");
    player.play("a");
    playing();
    player.next();
    playing();
    expect(recordPlay.mock.calls).toEqual([
      ["a", "pl-2"],
      ["b", "pl-2"],
    ]);
  });

  it("a failed report never surfaces", async () => {
    recordPlay.mockRejectedValueOnce(new Error("offline"));
    player.setPlaylist([track("a")], null);
    player.play("a");
    expect(() => playing()).not.toThrow();
    await Promise.resolve();
  });
});

describe("volume", () => {
  it("defaults to full and persists changes across a reload", () => {
    expect(player.getState().volume).toBe(1);
    player.setVolume(0.4);
    expect(getAudioElement().volume).toBeCloseTo(0.4);
    expect(player.getState().volume).toBeCloseTo(0.4);
    expect(localStorage.getItem("playerVolume")).toBe("0.4");
  });

  it("clamps to 0..1", () => {
    player.setVolume(4);
    expect(player.getState().volume).toBe(1);
    player.setVolume(-1);
    expect(player.getState().volume).toBe(0);
  });

  it("notifies subscribers", () => {
    const seen: number[] = [];
    const off = player.subscribe((s) => seen.push(s.volume));
    player.setVolume(0.25);
    off();
    expect(seen).toContain(0.25);
  });
});
