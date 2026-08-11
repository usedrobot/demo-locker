// @vitest-environment happy-dom
//
// Who is the owner, and what happens when the page cannot find out.
//
// PlaylistView defined "owner" a second way — `playlist.ownerId ===
// currentUserId` — where Home used the server's own rule, `lockerOwnerId ===
// null`. The two agreed only by the coincidence that playlists.ownerId happens
// to hold the locker id and the owner's own id happens to equal it. Nothing
// enforced that, and one definition of a concept is the point.
//
// The failure half is worse than the duplication: auth.me() ended in a bare
// .catch(() => {}), so one transient blip left the LOCKER OWNER with no
// [rename], no [make public], no [+ add tracks], no reorder, no artwork and no
// comment moderation — fail-closed, but with nothing on screen to say why. It
// reads exactly like "you are a listener now".
//
// House test pattern (createRoot + act, no @testing-library/react — not a
// dependency of this project). See PlaylistView.rename.test.tsx.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PlaylistView from "./PlaylistView";
import type { Playlist, Track } from "../lib/api";

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
    getState: () => ({ track: null, playing: false, duration: 0, currentTime: 0 }),
    subscribe: () => () => {},
    setPlaylist: vi.fn(),
    play: vi.fn(),
    seek: vi.fn(),
    clear: vi.fn(),
  },
}));

import { playlists as playlistsApi, auth } from "../lib/api";

const getMock = vi.mocked(playlistsApi.get);
const meMock = vi.mocked(auth.me);
const updateMock = vi.mocked(playlistsApi.update);

const OWNER_ID = "u-owner";

const playlist: Playlist = {
  createdByMe: false,
  createdByName: null,
  id: "pl-1",
  name: "owner demos",
  // The LOCKER's id. It happens to equal the owner's user id today; nothing
  // guarantees it will, which is the whole reason for the second definition
  // this file exists to remove.
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

const text = () => container.textContent ?? "";
const publishButton = () =>
  Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("make public")
  );
const renameButton = () =>
  Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("rename")
  );
const alerts = () => Array.from(container.querySelectorAll('[role="alert"]'));

beforeEach(() => {
  getMock.mockReset();
  meMock.mockReset();
  updateMock.mockReset();
  getMock.mockResolvedValue({ playlist, tracks: [track] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PlaylistView's owner rule", () => {
  it("gives the locker owner the publish control", async () => {
    meMock.mockResolvedValue({
      user: { id: OWNER_ID, email: "o@t.dev", accent: null, displayName: null, lockerOwnerId: null },
    });
    render();
    await flush();

    expect(text(), "the page did not render").toContain("take 3");
    expect(publishButton()).toBeDefined();
    expect(renameButton()).toBeDefined();
  });

  // The two rules happen to AGREE on every input reachable today — which is
  // exactly why the duplication was worth removing rather than debugging: the
  // agreement rests on playlists.ownerId holding the locker id and the owner's
  // own id equalling it, and nothing enforces either. What is pinned here is
  // that the surviving rule is the SERVER's (lockerOwnerId === null), applied
  // to a viewer whose id is deliberately not the locker's: an account that
  // owns a different locker is not this locker's owner, however the comparison
  // is written.
  it("does not mistake the owner of another locker for this one's", async () => {
    meMock.mockResolvedValue({
      user: {
        id: "u-other-owner",
        email: "other@t.dev",
        accent: null,
        displayName: null,
        lockerOwnerId: null,
      },
    });
    render();
    await flush();

    expect(text(), "the page did not render").toContain("take 3");
    expect(publishButton()).toBeUndefined();
    expect(renameButton()).toBeUndefined();
  });

  it("withholds publish from a collaborator but keeps rename", async () => {
    meMock.mockResolvedValue({
      user: {
        id: "u-collab",
        email: "c@t.dev",
        accent: null,
        displayName: null,
        lockerOwnerId: OWNER_ID,
      },
    });
    render();
    await flush();

    // Pin the page: a missing button must fail for the right reason.
    expect(text(), "the page did not render").toContain("take 3");
    expect(renameButton()).toBeDefined();
    expect(publishButton()).toBeUndefined();
  });

  it("withholds both from a collaborator on someone else's locker", async () => {
    meMock.mockResolvedValue({
      user: {
        id: "u-stranger",
        email: "x@t.dev",
        accent: null,
        displayName: null,
        lockerOwnerId: "u-some-other-locker",
      },
    });
    render();
    await flush();

    expect(text(), "the page did not render").toContain("take 3");
    expect(renameButton()).toBeUndefined();
    expect(publishButton()).toBeUndefined();
  });
});

// The server goes out of its way to answer a non-owner's publish attempt with
// a readable 403 — "only the locker owner can publish a playlist" — which is
// the entire point of the documented exception to this API's blanket 404 rule.
// The client dropped it as an unhandled rejection, so the collaborator who
// clicked saw the toggle do nothing and was told nothing.
describe("PlaylistView surfaces a refused write", () => {
  it("shows the server's reason when publishing is refused", async () => {
    meMock.mockResolvedValue({
      user: { id: OWNER_ID, email: "o@t.dev", accent: null, displayName: null, lockerOwnerId: null },
    });
    updateMock.mockRejectedValue(new Error("only the locker owner can publish a playlist"));
    render();
    await flush();

    const button = publishButton();
    expect(button, "the publish control was not on screen to click").toBeDefined();
    act(() => button!.click());
    await flush();

    const alerted = alerts();
    expect(alerted.length, "the refusal was swallowed").toBeGreaterThan(0);
    expect(alerted.map((n) => n.textContent).join(" ")).toContain(
      "only the locker owner can publish a playlist"
    );
  });
});

describe("PlaylistView when it cannot find out who the viewer is", () => {
  it("says so instead of silently demoting the owner to a listener", async () => {
    meMock.mockRejectedValue(new Error("network down"));
    render();
    await flush();

    // The controls are gone — fail closed, which is right — but the page now
    // explains itself rather than reading as "you are a listener now".
    expect(publishButton()).toBeUndefined();
    expect(renameButton()).toBeUndefined();

    const alerted = alerts();
    expect(alerted.length, "no error was surfaced at all").toBeGreaterThan(0);
    expect(alerted.map((n) => n.textContent).join(" ")).toContain("network down");
  });

  it("surfaces a failure to load the playlist itself too", async () => {
    getMock.mockRejectedValue(new Error("playlist unreachable"));
    meMock.mockResolvedValue({
      user: { id: OWNER_ID, email: "o@t.dev", accent: null, displayName: null, lockerOwnerId: null },
    });
    render();
    await flush();

    const alerted = alerts();
    expect(alerted.length, "the page sat on loading... forever").toBeGreaterThan(0);
    expect(alerted.map((n) => n.textContent).join(" ")).toContain("playlist unreachable");
  });
});

// The embed snippet is a two-row textarea plus an api line that used to render
// open, above the track list, on every visit to a public playlist — permanent
// vertical cost for something you copy once. It is now collapsed behind a
// control below the list.
describe("PlaylistView's public embed panel", () => {
  const embedToggle = () =>
    Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("public embed")
    );
  const embedPanel = () => container.querySelector("#public-embed-panel");

  it("offers nothing to embed on a private playlist", async () => {
    getMock.mockResolvedValue({ playlist, tracks: [track] });
    meMock.mockResolvedValue({ user: { id: OWNER_ID, lockerOwnerId: null } as never });
    render();
    await flush();

    // Absent, not disabled: a control that can never do anything here has no
    // state worth announcing.
    expect(embedToggle()).toBeUndefined();
    expect(embedPanel()).toBeNull();
  });

  it("starts collapsed on a public playlist, and opens on activation", async () => {
    getMock.mockResolvedValue({
      playlist: { ...playlist, isPublic: true },
      tracks: [track],
    });
    meMock.mockResolvedValue({ user: { id: OWNER_ID, lockerOwnerId: null } as never });
    render();
    await flush();

    const toggle = embedToggle();
    expect(toggle, "no [ public embed ] control on a public playlist").toBeDefined();
    // Collapsed is the whole point — asserted as the panel being ABSENT, not
    // merely invisible, so the readonly textarea is not a tab stop until asked
    // for.
    expect(embedPanel()).toBeNull();
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(embedPanel(), "the panel did not open").not.toBeNull();
    expect(embedToggle()!.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("textarea")?.value).toContain(
      '<demo-locker-player playlist="pl-1">'
    );
  });
});
