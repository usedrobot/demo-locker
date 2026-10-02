// @vitest-environment happy-dom
//
// Per-playlist accent: the page paints in the playlist's own colour while it is
// open, the swatch steps through the palette the way the account swatch on
// Home does and saves the choice, and leaving puts the account colour back.
// House test pattern (createRoot + act).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PlaylistView from "./PlaylistView";
import type { Playlist } from "../lib/api";

vi.mock("../lib/api", () => ({
  auth: {
    me: vi.fn(async () => ({
      user: { id: "u-1", email: "o@t.dev", accent: null, displayName: null, lockerOwnerId: null },
    })),
  },
  playlists: {
    get: vi.fn(),
    update: vi.fn(),
    reorder: vi.fn(async () => ({})),
    artworkUrl: () => null,
  },
  tracks: { list: vi.fn(async () => ({ tracks: [] })) },
  shares: { forPlaylist: vi.fn(async () => ({ shares: [] })) },
  comments: {
    forPlaylist: vi.fn(async () => ({ comments: [] })),
    forTrack: vi.fn(async () => ({ comments: [] })),
  },
  getApiOrigin: () => "http://localhost:3001",
}));

vi.mock("../lib/audio", () => ({
  player: {
    getState: () => ({ track: null, playing: false, duration: 0, currentTime: 0 }),
    subscribe: () => () => {},
    setPlaylist: vi.fn(),
    play: vi.fn(),
    seek: vi.fn(),
    clear: vi.fn(),
  },
}));

import { playlists as playlistsApi } from "../lib/api";
import { applyAccent } from "../lib/theme";

const getMock = vi.mocked(playlistsApi.get);
const updateMock = vi.mocked(playlistsApi.update);

const BLUE = "#4af";
const GREEN = "#3f6";

function playlist(over: Partial<Playlist> = {}): Playlist {
  return {
    createdByMe: true,
    createdByName: null,
    id: "pl-1",
    name: "swamp cats demos",
    ownerId: "u-1",
    artworkKey: null,
    isPublic: false,
    accent: BLUE,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render() {
  act(() => {
    root.render(<PlaylistView playlistId="pl-1" onBack={() => {}} />);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function accentVar() {
  return document.documentElement.style.getPropertyValue("--accent");
}

function swatch() {
  return container.querySelector<HTMLButtonElement>('button[aria-label="Change this playlist\'s color"]');
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("accent", "#fc0"); // the account accent: gold
  applyAccent("#fc0");
  getMock.mockReset();
  updateMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  container.remove();
});

describe("PlaylistView — playlist accent", () => {
  it("paints the playlist's colour while open and restores the account colour on leaving", async () => {
    getMock.mockResolvedValue({ playlist: playlist(), tracks: [] });
    render();
    await flush();
    expect(accentVar()).toBe(BLUE);
    act(() => root.unmount());
    expect(accentVar()).toBe("#fc0");
    // Viewing never rewrites the account setting.
    expect(localStorage.getItem("accent")).toBe("#fc0");
  });

  it("the swatch moves to the next palette colour and saves it", async () => {
    getMock.mockResolvedValue({ playlist: playlist(), tracks: [] });
    updateMock.mockResolvedValue({ playlist: playlist({ accent: GREEN }) });
    render();
    await flush();
    await act(async () => swatch()!.click());
    await flush();
    // blue -> green is the next step in ACCENTS, same order as Home's swatch.
    expect(updateMock).toHaveBeenCalledWith("pl-1", { accent: GREEN });
    expect(accentVar()).toBe(GREEN);
    expect(localStorage.getItem("accent")).toBe("#fc0");
    act(() => root.unmount());
  });

  it("a refused save puts the old colour back and says why", async () => {
    getMock.mockResolvedValue({ playlist: playlist(), tracks: [] });
    updateMock.mockRejectedValue(new Error("unsupported accent"));
    render();
    await flush();
    await act(async () => swatch()!.click());
    await flush();
    expect(accentVar()).toBe(BLUE);
    expect(container.textContent).toContain("unsupported accent");
    act(() => root.unmount());
  });

  it("a playlist with no accent of its own shows the account colour", async () => {
    getMock.mockResolvedValue({ playlist: playlist({ accent: null }), tracks: [] });
    render();
    await flush();
    expect(accentVar()).toBe("#fc0");
    act(() => root.unmount());
  });
});
