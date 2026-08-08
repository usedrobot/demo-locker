// @vitest-environment happy-dom
//
// PlaylistView already distinguished `canManage` (a member of this locker)
// from `isOwner` (owns the locker; gates publishing only) for its own
// controls, but handed `isOwner` to both <Comments> callsites. A collaborator
// therefore saw no resolve or delete control on comments the API now lets
// them moderate. This pins which of the two the comment panels get.
//
// House test pattern (createRoot + act, no @testing-library/react — not a
// dependency of this project). See PlaylistView.rename.test.tsx.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PlaylistView from "./PlaylistView";
import type { Playlist, Comment, Track } from "../lib/api";

vi.mock("../lib/api", () => ({
  auth: { me: vi.fn() },
  playlists: {
    get: vi.fn(),
    update: vi.fn(),
    reorder: vi.fn(async () => ({})),
    artworkUrl: () => null,
  },
  tracks: {
    list: vi.fn(async () => ({ tracks: [] })),
    downloadUrl: (id: string) => `/tracks/${id}/download`,
    streamUrl: (id: string) => `/tracks/${id}/stream`,
  },
  shares: { forPlaylist: vi.fn(async () => ({ shares: [] })) },
  comments: {
    forPlaylist: vi.fn(),
    forTrack: vi.fn(async () => ({ comments: [] })),
    create: vi.fn(async () => ({ comment: {} })),
    resolve: vi.fn(async () => ({ comment: {} })),
    remove: vi.fn(async () => ({ ok: true })),
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

import { playlists as playlistsApi, auth, comments as commentsApi } from "../lib/api";

const getMock = vi.mocked(playlistsApi.get);
const meMock = vi.mocked(auth.me);
const forPlaylistMock = vi.mocked(commentsApi.forPlaylist);
const forTrackMock = vi.mocked(commentsApi.forTrack);

const OWNER_ID = "u-owner";

const playlist: Playlist = {
  createdByMe: false,
  createdByName: null,
  id: "pl-1",
  name: "owner demos",
  // The LOCKER's id, which is the owner's — not necessarily the viewer's.
  ownerId: OWNER_ID,
  artworkKey: null,
  isPublic: false,
  createdAt: "",
  updatedAt: "",
};

const track: Track = {
  id: "tr-1",
  playlistId: "pl-1",
  title: "take 3",
  position: 0,
  hasStream: true,
  waveformData: null,
  duration: 120,
  uploadedAt: "",
  uploadedByMe: false,
  uploadedByName: null,
};

const comment: Comment = {
  id: "c-1",
  trackId: null,
  playlistId: "pl-1",
  parentId: null,
  authorName: "Listener",
  body: "needs a louder snare",
  timestampSec: null,
  createdAt: "",
  resolvedAt: null,
  replies: [],
};

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

function commentRows(): Element[] {
  return Array.from(container.querySelectorAll(".comment"));
}

function resolveButtons(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      'button[title="Mark as resolved"], button[title="Mark as open"]'
    )
  );
}

beforeEach(() => {
  getMock.mockReset();
  meMock.mockReset();
  forPlaylistMock.mockReset();
  forTrackMock.mockReset();
  getMock.mockResolvedValue({ playlist, tracks: [track] });
  forPlaylistMock.mockResolvedValue({ comments: [comment] });
  forTrackMock.mockResolvedValue({ comments: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("who may moderate comments in PlaylistView", () => {
  it("gives a collaborator the resolve control on the locker's playlist", async () => {
    // A collaborator: their own id is never the locker's id.
    meMock.mockResolvedValue({
      user: { id: "u-collab", email: "c@t.dev", accent: null, lockerOwnerId: OWNER_ID },
    });
    render();
    await flush();

    expect(commentRows()).toHaveLength(1);
    expect(resolveButtons()).toHaveLength(1);
  });

  it("gives the owner the same control", async () => {
    meMock.mockResolvedValue({
      user: { id: OWNER_ID, email: "o@t.dev", accent: null, lockerOwnerId: null },
    });
    render();
    await flush();

    expect(commentRows()).toHaveLength(1);
    expect(resolveButtons()).toHaveLength(1);
  });

  // The track-level panel is a second, separate callsite (PlaylistView passed
  // the wrong flag to BOTH), and it only mounts once a track is selected.
  it("gives a collaborator the same control on the track panel", async () => {
    forTrackMock.mockResolvedValue({ comments: [{ ...comment, id: "c-2", trackId: "tr-1" }] });
    meMock.mockResolvedValue({
      user: { id: "u-collab", email: "c@t.dev", accent: null, lockerOwnerId: OWNER_ID },
    });
    render();
    await flush();

    const row = container.querySelector<HTMLElement>(
      'div[title="Click to play · Drag to reorder"]'
    );
    expect(row).not.toBeNull();
    act(() => row!.click());
    await flush();

    // Both panels are now on screen: the track's comment and the playlist's.
    expect(commentRows()).toHaveLength(2);
    expect(resolveButtons()).toHaveLength(2);
  });

  it("withholds it from a viewer outside the locker, with the comment on screen", async () => {
    meMock.mockResolvedValue({
      user: { id: "u-other", email: "x@t.dev", accent: null, lockerOwnerId: null },
    });
    render();
    await flush();

    // Pin the row: the assertion below must fail for the right reason.
    expect(commentRows()).toHaveLength(1);
    expect(container.textContent).toContain("needs a louder snare");
    expect(resolveButtons()).toHaveLength(0);
  });
});
