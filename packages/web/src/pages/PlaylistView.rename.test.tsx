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

import { playlists as playlistsApi } from "../lib/api";

const getMock = vi.mocked(playlistsApi.get);
const updateMock = vi.mocked(playlistsApi.update);

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
});
