// @vitest-environment happy-dom
//
// The [x] on a track inside a playlist used to call DELETE /tracks/:id, which
// erases the lossless master and the AAC rendition from the bucket — while the
// button's tooltip, confirm text and aria-label all said "remove". Two clicks
// and an irreplaceable file was gone.
//
// These assertions are about which API call the control makes, not about
// wording, because wording is what made the old behaviour plausible.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import TrackList from "./TrackList";
import type { Track } from "../lib/api";

vi.mock("../lib/api", () => ({
  tracks: {
    attach: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    downloadUrl: (id: string) => `/tracks/${id}/download`,
  },
}));
vi.mock("../lib/audio", () => ({
  player: {
    getState: () => ({ track: null, playing: false, duration: 0, currentTime: 0 }),
    subscribe: () => () => {},
    play: vi.fn(),
    clear: vi.fn(),
  },
}));

import { tracks as tracksApi } from "../lib/api";

const attachMock = vi.mocked(tracksApi.attach);
const deleteMock = vi.mocked(tracksApi.delete);

const track = {
  id: "t1",
  title: "Everything Everywhere",
  duration: 254,
  hasStream: true,
  playlistId: "p1",
} as unknown as Track;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(onRemove?: (id: string) => void) {
  act(() => {
    root.render(
      <TrackList tracks={[track]} onReorder={() => {}} onRemove={onRemove} />,
    );
  });
}

function removeButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    'button[aria-label*="from this playlist"]',
  );
}

describe("TrackList remove control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("detaches the track instead of deleting it", () => {
    const onRemove = vi.fn();
    render(onRemove);

    const btn = removeButton();
    expect(btn).not.toBeNull();

    // First click only arms the confirm — nothing should reach the API yet.
    act(() => btn!.click());
    expect(attachMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();

    act(() => btn!.click());

    // The assertion that matters: detach, with a null playlist.
    expect(attachMock).toHaveBeenCalledWith("t1", null);
    // The one that would have cost a master.
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("never renders a destructive control when onRemove is absent", () => {
    render(undefined);
    expect(removeButton()).toBeNull();
  });
});
