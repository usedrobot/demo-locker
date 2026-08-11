// @vitest-environment happy-dom
//
// What the anonymous share-link view offers, and — the point of this file —
// what it must NOT offer.
//
// An `edit` share link grants re-arranging the playlist and nothing more. It
// cannot upload: POST /tracks/upload requires a session acting in the
// playlist's locker (packages/api/src/lib/playlist-access.ts,
// requestCanUploadToPlaylist). The server refusal is tested there; this file
// covers the other half, because a control the server refuses is worse than no
// control — this repo has already shipped that bug once, as an ungated [x] that
// silently 404'd for collaborators.
//
// House test pattern (createRoot + act) — @testing-library/react is not a
// dependency of this project.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import Invite from "./Invite";
import type { Playlist, Track } from "../lib/api";

vi.mock("../lib/api", () => ({
  shares: { resolveInvite: vi.fn() },
  playlists: { reorder: vi.fn(async () => ({})) },
  // TrackList renders a download link and a detach control off these.
  tracks: {
    downloadUrl: (id: string) => `/tracks/${id}/download`,
    attach: vi.fn(async () => ({})),
  },
  setShareToken: vi.fn(),
}));

vi.mock("../lib/audio", () => ({
  player: {
    getState: () => ({ track: null, playing: false, duration: 0, currentTime: 0 }),
    subscribe: () => () => {},
    setPlaylist: vi.fn(),
    play: vi.fn(),
    seek: vi.fn(),
  },
}));

vi.mock("../lib/theme", () => ({ previewAccent: () => () => {} }));

// Both do their own fetching and have their own concerns; this page's question
// is only which controls it renders.
vi.mock("../components/Comments", () => ({ default: () => <div data-testid="comments" /> }));
vi.mock("../components/AsciiText", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

import { shares as sharesApi } from "../lib/api";

const resolveInviteMock = vi.mocked(sharesApi.resolveInvite);

const playlist: Playlist = {
  id: "pl-shared",
  name: "shared demos",
  ownerId: "u-owner",
  artworkKey: null,
  isPublic: false,
  createdAt: "",
  updatedAt: "",
  createdByMe: false,
  createdByName: null,
};

const track: Track = {
  id: "tr-1",
  playlistId: "pl-shared",
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
    root.render(<Invite token="tok-abc" />);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// The upload control is a file input behind a label — matched by BOTH, so the
// assertion cannot be satisfied by merely hiding one of them.
function uploadControls(): Element[] {
  return [
    ...container.querySelectorAll('input[type="file"]'),
    ...Array.from(container.querySelectorAll("label, button")).filter((el) =>
      /upload|add track|\+ add/i.test(el.textContent ?? "")
    ),
  ];
}

beforeEach(() => {
  resolveInviteMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Invite — a share link cannot upload", () => {
  it("offers no upload control on an EDIT link", async () => {
    resolveInviteMock.mockResolvedValue({
      playlist,
      tracks: [track],
      permission: "edit",
      accent: null,
    } as never);
    render();
    await flush();

    // The page did load — otherwise "no upload control" would pass on a blank
    // screen, which is the way this assertion most easily fools you.
    expect(container.textContent).toContain("shared demos");
    expect(container.textContent).toContain("take 3");

    expect(
      uploadControls().map((el) => el.outerHTML.slice(0, 80)),
      "an edit share link is being offered an upload control the server will refuse"
    ).toEqual([]);
  });

  it("offers no upload control on a LISTEN link either", async () => {
    resolveInviteMock.mockResolvedValue({
      playlist,
      tracks: [track],
      permission: "listen",
      accent: null,
    } as never);
    render();
    await flush();

    expect(container.textContent).toContain("shared demos");
    expect(uploadControls()).toEqual([]);
  });

  it("says what an edit link can actually do", async () => {
    resolveInviteMock.mockResolvedValue({
      playlist,
      tracks: [track],
      permission: "edit",
      accent: null,
    } as never);
    render();
    await flush();

    // Not "listen + edit": the header is the only place this view tells the
    // holder what they are allowed to do, so it has to name the real
    // capability rather than the stored permission value.
    expect(container.textContent).toContain("listen + re-arrange");
    expect(container.textContent).not.toContain("listen + edit");
  });
});
