// @vitest-environment happy-dom
//
// Covers the rename control added to PlaylistView: commit on Enter, discard
// on Escape, and refuse to submit a blank/whitespace name. Follows the house
// test pattern (createRoot + act, no @testing-library/react — not a
// dependency of this project).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PlaylistView from "./PlaylistView";
import type { Playlist } from "../lib/api";

vi.mock("../lib/api", () => ({
  auth: {
    me: vi.fn(async () => ({
      user: { id: "u-1", email: "o@t.dev", accent: null, lockerOwnerId: null },
    })),
  },
  playlists: {
    get: vi.fn(),
    update: vi.fn(),
    reorder: vi.fn(async () => ({})),
    artworkUrl: () => null,
  },
  tracks: {
    list: vi.fn(async () => ({ tracks: [] })),
  },
  shares: {
    forPlaylist: vi.fn(async () => ({ shares: [] })),
  },
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

import { playlists as playlistsApi, auth } from "../lib/api";

const getMock = vi.mocked(playlistsApi.get);
const updateMock = vi.mocked(playlistsApi.update);
const meMock = vi.mocked(auth.me);

const playlist: Playlist = {
  id: "pl-1",
  name: "old name",
  ownerId: "u-1",
  artworkKey: null,
  isPublic: false,
  createdAt: "",
  updatedAt: "",
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
  });
}

function renameButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-label*="rename" i]')
    ?? Array.from(container.querySelectorAll("button")).find((b) =>
      /rename/i.test(b.textContent ?? "")
    ) ?? null;
}

function nameInput(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('input[aria-label="playlist name"]');
}

// React wraps the DOM node's "value" property with its own tracker so it can
// tell whether a write came from the user or from itself; assigning
// `input.value = ...` goes through that tracker and React sees no change. The
// native setter bypasses the tracker, same trick @testing-library/react's
// fireEvent uses under the hood.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value"
)!.set!;

function typeValue(input: HTMLInputElement, value: string) {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("playlist rename", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockResolvedValue({ playlist, tracks: [] });
    updateMock.mockResolvedValue({ playlist: { ...playlist, name: "new name" } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("commits a new name on Enter", async () => {
    render();
    await flush();

    const btn = renameButton();
    expect(btn).not.toBeNull();
    act(() => btn!.click());

    const input = nameInput();
    expect(input).not.toBeNull();

    act(() => typeValue(input!, "new name"));
    act(() => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    await flush();

    expect(updateMock).toHaveBeenCalledWith("pl-1", { name: "new name" });
  });

  it("discards the edit on Escape without calling the API", async () => {
    render();
    await flush();

    const btn = renameButton();
    act(() => btn!.click());

    const input = nameInput();
    act(() => typeValue(input!, "abandoned"));
    act(() => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    await flush();

    expect(updateMock).not.toHaveBeenCalled();
    expect(nameInput()).toBeNull();
  });

  it("does not submit an empty name", async () => {
    render();
    await flush();

    const btn = renameButton();
    act(() => btn!.click());

    const input = nameInput();
    act(() => typeValue(input!, "   "));
    act(() => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    await flush();

    expect(updateMock).not.toHaveBeenCalled();
  });

  // React implements onBlur via a delegated "focusout" listener (native
  // blur/focus don't bubble), so that's what a test has to dispatch to
  // exercise the handler — a bare .blur() call alone won't reach it.
  it("commits the edit when focus leaves the input instead of discarding it", async () => {
    render();
    await flush();

    const btn = renameButton();
    act(() => btn!.click());

    const input = nameInput();
    act(() => typeValue(input!, "clicked away"));
    act(() => {
      input!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flush();

    expect(updateMock).toHaveBeenCalledWith("pl-1", { name: "clicked away" });
  });

  it("does not double-commit when Enter's own unmount triggers a blur", async () => {
    render();
    await flush();

    const btn = renameButton();
    act(() => btn!.click());

    const input = nameInput();
    act(() => typeValue(input!, "new name"));
    act(() => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    await flush();
    // The input has unmounted; fire the focusout a real browser would emit
    // when a focused node is removed from the DOM, same as Escape's path.
    act(() => {
      input!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flush();

    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("does not pin a stale rename error once the editor closes with no change", async () => {
    // The error <div> is not gated on `renaming` — it survives the input
    // unmounting. A failed attempt must not leave it stranded once the user
    // backs out to the original name and the editor closes.
    updateMock.mockRejectedValueOnce(new Error("name already taken"));
    render();
    await flush();

    act(() => renameButton()!.click());
    act(() => typeValue(nameInput()!, "taken name"));
    act(() => {
      nameInput()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    await flush();

    expect(container.textContent).toContain("name already taken");

    // Revert to the original name and commit again — a no-op that closes
    // the editor without calling the API.
    act(() => typeValue(nameInput()!, "old name"));
    act(() => {
      nameInput()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    await flush();

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(nameInput()).toBeNull();
    expect(container.textContent).not.toContain("name already taken");
  });
});

describe("playlist rename — collaborator access", () => {
  const ownerPlaylist: Playlist = {
    id: "pl-2",
    name: "owner's playlist",
    ownerId: "u-owner",
    artworkKey: null,
    isPublic: false,
    createdAt: "",
    updatedAt: "",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockResolvedValue({ playlist: ownerPlaylist, tracks: [] });
    updateMock.mockResolvedValue({ playlist: { ...ownerPlaylist, name: "new name" } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  // Guards the fix this task exists for: a collaborator's own id is never
  // playlist.ownerId (that's the locker owner's id), so gating library
  // controls on `playlist.ownerId === currentUserId` — the pre-fix check —
  // hides them for every collaborator. canManage instead resolves the
  // locker the same way the API does: lockerOwnerId ?? own id.
  it("grants library controls to a collaborator, but not publishing", async () => {
    meMock.mockResolvedValue({
      user: { id: "u-collab", email: "c@t.dev", accent: null, lockerOwnerId: "u-owner" },
    });

    render();
    await flush();

    expect(renameButton()).not.toBeNull();
    const addTracksBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      /add tracks/i.test(b.textContent ?? "")
    );
    expect(addTracksBtn).not.toBeUndefined();

    const publishBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      /make (public|private)/i.test(b.textContent ?? "")
    );
    expect(publishBtn).toBeUndefined();
  });
});
