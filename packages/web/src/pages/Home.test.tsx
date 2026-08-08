// @vitest-environment happy-dom
//
// Which delete affordances Home offers, and to whom.
//
// The server refuses a collaborator deleting someone else's upload, so an
// ungated [x] was offered and then silently 404'd — the user clicked, confirmed,
// and nothing happened with no explanation. The rule is `uploadedByMe ||
// isOwner` for tracks and `createdByMe || isOwner` for playlists (see
// packages/api/src/lib/public-track.ts), plus a catch so a refusal that gets
// through anyway is visible rather than an unhandled rejection.
//
// House test pattern (createRoot + act) — @testing-library/react is not a
// dependency of this project.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import Home from "./Home";
import type { Playlist, Track, User } from "../lib/api";

vi.mock("../lib/api", () => ({
  playlists: {
    list: vi.fn(async () => ({ playlists: [] })),
    delete: vi.fn(async () => ({})),
    artworkUrl: () => null,
  },
  tracks: {
    list: vi.fn(async () => ({ tracks: [] })),
    delete: vi.fn(async () => ({})),
  },
  shares: {
    listAll: vi.fn(async () => ({ shares: [] })),
    setPermission: vi.fn(async () => ({})),
    revoke: vi.fn(async () => ({})),
  },
  auth: {
    me: vi.fn(async () => ({ user: {} })),
    setAccent: vi.fn(async () => ({})),
  },
  setToken: vi.fn(),
}));

vi.mock("../lib/audio", () => ({
  player: {
    getState: () => ({ track: null, playing: false, duration: 0, currentTime: 0 }),
    subscribe: () => () => {},
    setPlaylist: vi.fn(),
    play: vi.fn(),
    toggle: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock("../lib/theme", () => ({ cycleAccent: () => "gold" }));

// The panel does its own loading and has its own test file; Home's concern is
// only whether it is mounted at all.
vi.mock("../components/CollabPanel", () => ({
  default: () => <div data-testid="collab-panel" />,
}));

vi.mock("../lib/use-upload-queue", () => ({
  useUploadQueue: () => ({
    pending: [],
    queue: vi.fn(),
    start: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
  }),
}));

import {
  playlists as playlistsApi,
  tracks as tracksApi,
  shares as sharesApi,
  auth,
} from "../lib/api";
import type { Share } from "../lib/api";

const listPlaylistsMock = vi.mocked(playlistsApi.list);
const listTracksMock = vi.mocked(tracksApi.list);
const deleteTrackMock = vi.mocked(tracksApi.delete);
const listSharesMock = vi.mocked(sharesApi.listAll);
const meMock = vi.mocked(auth.me);

const OWNER: User = { id: "u-owner", email: "o@test.dev", accent: null, lockerOwnerId: null };
const COLLABORATOR: User = {
  id: "u-collab",
  email: "c@test.dev",
  accent: null,
  lockerOwnerId: "u-owner",
};

function track(over: Partial<Track>): Track {
  return {
    id: "t-1",
    playlistId: null,
    title: "someone's demo",
    position: 0,
    hasStream: true,
    waveformData: null,
    duration: 120,
    uploadedAt: "",
    uploadedByMe: false,
    ...over,
  };
}

function playlist(over: Partial<Playlist>): Playlist {
  return {
    id: "p-1",
    name: "someone's playlist",
    ownerId: "u-owner",
    artworkKey: null,
    isPublic: false,
    createdAt: "",
    updatedAt: "2026-08-07T00:00:00.000Z",
    createdByMe: false,
    ...over,
  };
}

function share(over: Partial<Share>): Share {
  return {
    id: "s-1",
    playlistId: "p-1",
    playlistName: "owner demos",
    token: "abcdef123456",
    permission: "listen",
    email: null,
    createdAt: "",
    expiresAt: null,
    mintedByMe: false,
    ...over,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render() {
  act(() => {
    root.render(<Home onSelect={() => {}} onLogout={() => {}} />);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deleteButtons(labelFragment: string): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(`button[aria-label*="${labelFragment}"]`)
  );
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Home — delete controls under collaboration", () => {
  beforeEach(() => {
    listPlaylistsMock.mockReset();
    listPlaylistsMock.mockResolvedValue({ playlists: [] });
    listTracksMock.mockReset();
    listTracksMock.mockResolvedValue({ tracks: [] });
    deleteTrackMock.mockReset();
    deleteTrackMock.mockResolvedValue({});
    meMock.mockReset();
    meMock.mockResolvedValue({ user: OWNER });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("offers the owner a delete control on a collaborator's upload", async () => {
    // uploadedByMe is false for the owner on every collaborator upload, and the
    // owner may delete all of them — which is exactly why the client rule is
    // `uploadedByMe || isOwner` and not the field alone.
    listTracksMock.mockResolvedValue({ tracks: [track({ uploadedByMe: false })] });

    render();
    await flush();

    expect(deleteButtons("permanently").length).toBe(1);
  });

  it("does not offer a collaborator a delete control on someone else's upload", async () => {
    meMock.mockResolvedValue({ user: COLLABORATOR });
    listTracksMock.mockResolvedValue({ tracks: [track({ uploadedByMe: false })] });

    render();
    await flush();

    // Task 12 step 5 checks this live: the server refuses it, so offering the
    // control at all is a promise the app cannot keep.
    expect(deleteButtons("permanently")).toHaveLength(0);
    // The row itself is still there — otherwise this assertion would pass just
    // as well if the whole library failed to render.
    expect(container.textContent).toContain("someone's demo");
  });

  it("does offer a collaborator a delete control on their own upload", async () => {
    meMock.mockResolvedValue({ user: COLLABORATOR });
    listTracksMock.mockResolvedValue({ tracks: [track({ uploadedByMe: true })] });

    render();
    await flush();

    expect(deleteButtons("permanently").length).toBe(1);
  });

  it("does not offer a collaborator a delete control on someone else's playlist", async () => {
    meMock.mockResolvedValue({ user: COLLABORATOR });
    listPlaylistsMock.mockResolvedValue({ playlists: [playlist({ createdByMe: false })] });

    render();
    await flush();

    expect(deleteButtons("Delete playlist")).toHaveLength(0);
    expect(container.textContent).toContain("someone's playlist");
  });

  it("offers the owner a delete control on a collaborator's playlist", async () => {
    listPlaylistsMock.mockResolvedValue({ playlists: [playlist({ createdByMe: false })] });

    render();
    await flush();

    expect(deleteButtons("Delete playlist").length).toBe(1);
  });

  it("surfaces a refused track delete instead of silently doing nothing", async () => {
    // The gate is drawn from data that can be stale by the time the click
    // lands, so a refusal is unlikely rather than impossible — and without a
    // catch it is an unhandled rejection plus a list that does not change.
    listTracksMock.mockResolvedValue({ tracks: [track({ uploadedByMe: true })] });
    deleteTrackMock.mockRejectedValueOnce(new Error("not found"));

    render();
    await flush();

    const btn = deleteButtons("permanently")[0];
    act(() => btn.click()); // arms the two-step confirm
    act(() => btn.click());
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("not found");
    // The track is still listed, because it is still there.
    expect(container.textContent).toContain("someone's demo");
  });
});

// GET /shares is locker-scoped and this panel is NOT owner-gated: [access] is
// offered to everyone, so a collaborator opening it sees every link in the
// locker, including the owner's. `mintedByMe` is computed per acting user, so
// on that read the owner's links are false — which is why the marker may only
// ever state the positive case.
describe("Home — share attribution in the access panel", () => {
  beforeEach(() => {
    listPlaylistsMock.mockReset();
    listPlaylistsMock.mockResolvedValue({ playlists: [] });
    listTracksMock.mockReset();
    listTracksMock.mockResolvedValue({ tracks: [] });
    meMock.mockReset();
    meMock.mockResolvedValue({ user: OWNER });
    listSharesMock.mockReset();
    listSharesMock.mockResolvedValue({ shares: [] });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  async function openAccess() {
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "[access]"
    );
    expect(btn).toBeDefined();
    act(() => btn!.click());
    await flush();
  }

  it("marks a link the viewer minted themselves", async () => {
    listSharesMock.mockResolvedValue({ shares: [share({ mintedByMe: true })] });

    render();
    await flush();
    await openAccess();

    expect(container.textContent).toContain("yours");
  });

  it("says nothing about a link the viewer did not mint", async () => {
    listSharesMock.mockResolvedValue({ shares: [share({ mintedByMe: false })] });

    render();
    await flush();
    await openAccess();

    // The row is there — otherwise this would pass just as well if the panel
    // rendered nothing at all.
    expect(container.textContent).toContain("link …123456");
    expect(container.textContent).not.toContain("yours");
  });

  it("does not tell a collaborator that the owner's link came from a collaborator", async () => {
    meMock.mockResolvedValue({ user: COLLABORATOR });
    // The owner minted this one, so the collaborator's read of it is
    // mintedByMe: false. False is ambiguous by construction — it must never be
    // rendered as an attribution to anyone.
    listSharesMock.mockResolvedValue({ shares: [share({ mintedByMe: false })] });

    render();
    await flush();
    await openAccess();

    expect(container.textContent).toContain("link …123456");
    expect(container.textContent).not.toContain("collaborator");
    expect(container.textContent).not.toContain("yours");
  });

  it("marks a collaborator's own link as theirs", async () => {
    meMock.mockResolvedValue({ user: COLLABORATOR });
    listSharesMock.mockResolvedValue({ shares: [share({ mintedByMe: true })] });

    render();
    await flush();
    await openAccess();

    // Same rule for both roles: the marker follows the acting user, not the
    // locker owner.
    expect(container.textContent).toContain("yours");
  });
});

describe("Home — the collaborators panel", () => {
  beforeEach(() => {
    listPlaylistsMock.mockReset();
    listPlaylistsMock.mockResolvedValue({ playlists: [] });
    listTracksMock.mockReset();
    listTracksMock.mockResolvedValue({ tracks: [] });
    meMock.mockReset();
    meMock.mockResolvedValue({ user: OWNER });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("mounts for the locker owner", async () => {
    render();
    await flush();

    expect(container.querySelector('[data-testid="collab-panel"]')).not.toBeNull();
  });

  it("does not mount for a collaborator", async () => {
    meMock.mockResolvedValue({ user: COLLABORATOR });

    render();
    await flush();

    // A collaborator may not see who else is in the locker, let alone invite
    // anyone — every /collab route 404s them.
    expect(container.querySelector('[data-testid="collab-panel"]')).toBeNull();
  });
});
