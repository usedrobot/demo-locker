// @vitest-environment happy-dom
//
// The add picker must offer every library track that is not already in THIS
// playlist. Before the join table it offered only tracks in NO playlist, which
// is why a track could never be added to a second one.
//
// House test pattern (createRoot + act). See PlaylistView.owner.test.tsx.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PlaylistView from "./PlaylistView";
import type { Playlist, Track, User } from "../lib/api";

vi.mock("../lib/api", () => ({
  auth: { me: vi.fn() },
  playlists: {
    get: vi.fn(),
    update: vi.fn(),
    reorder: vi.fn(async () => ({})),
    addTrack: vi.fn(async () => ({ ok: true, added: true })),
    removeTrack: vi.fn(async () => ({ ok: true })),
    artworkUrl: () => null,
  },
  tracks: {
    list: vi.fn(),
    downloadUrl: (id: string) => `/tracks/${id}/download`,
    streamUrl: (id: string) => `/tracks/${id}/stream`,
  },
  shares: { forPlaylist: vi.fn(async () => ({ shares: [] })) },
  comments: {
    forPlaylist: vi.fn(async () => ({ comments: [] })),
    forTrack: vi.fn(async () => ({ comments: [] })),
    create: vi.fn(async () => ({ comment: {} })),
    resolve: vi.fn(async () => ({ comment: {} })),
    remove: vi.fn(async () => ({ ok: true })),
  },
  getApiOrigin: () => "http://localhost:3001",
}));

vi.mock("../lib/audio", () => ({
  player: {
    getState: () => ({ track: null, playlistId: null, playing: false, duration: 0, currentTime: 0 }),
    subscribe: () => () => {},
    setPlaylist: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    clear: vi.fn(),
  },
}));

import { playlists as playlistsApi, tracks as tracksApi, auth } from "../lib/api";

const OWNER: User = { id: "u1", email: "o@test.dev", accent: null, displayName: null, lockerOwnerId: null };

const playlist: Playlist = {
  id: "pl-1",
  name: "reel",
  ownerId: "u1",
  artworkKey: null,
  isPublic: false,
  createdAt: "",
  updatedAt: "",
  createdByMe: true,
  createdByName: null,
};

function track(over: Partial<Track>): Track {
  return {
    id: "t",
    title: "t",
    hasStream: true,
    waveformData: null,
    duration: 10,
    uploadedAt: "",
    uploadedByMe: true,
    uploadedByName: null,
    ...over,
  };
}

const here = track({ id: "t-here", title: "already here", playlistIds: ["pl-1"] });
const elsewhere = track({ id: "t-else", title: "in another", playlistIds: ["pl-2"] });
const nowhere = track({ id: "t-lib", title: "library only", playlistIds: [] });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button"));
}

async function openPicker() {
  act(() => {
    root.render(<PlaylistView playlistId="pl-1" onBack={() => {}} />);
  });
  await flush();
  const openBtn = buttons().find((b) => (b.textContent ?? "").includes("add tracks"));
  expect(openBtn).toBeDefined();
  await act(async () => {
    openBtn!.click();
  });
  await flush();
}

describe("PlaylistView add-tracks picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.me).mockResolvedValue({ user: OWNER });
    vi.mocked(playlistsApi.get).mockResolvedValue({ playlist, tracks: [{ ...here, position: 0 }] });
    vi.mocked(tracksApi.list).mockResolvedValue({ tracks: [here, elsewhere, nowhere] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers tracks in other playlists and in none, but not the ones already here", async () => {
    await openPicker();
    const addButtons = buttons().filter((b) => (b.textContent ?? "").includes("[+ add]"));
    const offered = addButtons.map((b) => b.parentElement?.textContent ?? "");
    expect(offered.some((t) => t.includes("in another"))).toBe(true);
    expect(offered.some((t) => t.includes("library only"))).toBe(true);
    expect(offered.some((t) => t.includes("already here"))).toBe(false);
    expect(addButtons).toHaveLength(2);
  });

  it("adds through the playlist route", async () => {
    await openPicker();
    const row = buttons().find(
      (b) => (b.textContent ?? "").includes("[+ add]") && (b.parentElement?.textContent ?? "").includes("in another")
    );
    expect(row).toBeDefined();
    await act(async () => {
      row!.click();
    });
    await flush();
    expect(playlistsApi.addTrack).toHaveBeenCalledWith("pl-1", "t-else");
  });
});
