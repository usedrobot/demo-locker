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

function render(onRemove?: (id: string) => void, list: Track[] = [track]) {
  act(() => {
    root.render(
      <TrackList tracks={list} onReorder={() => {}} onRemove={onRemove} />,
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

// Whose demo is this — on the rows inside a playlist. Same rules as Home's
// library list: the caller's own rows read "you", another member's read their
// name, and a row with nothing to attribute renders nothing at all. That last
// case is also what an anonymous share holder sees on every row, because the
// API sends them no names (packages/api/src/lib/display-name.ts).
describe("TrackList attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  function attributions(): string[] {
    return Array.from(container.querySelectorAll("[data-attribution]")).map(
      (el) => el.textContent ?? ""
    );
  }

  // Catches an EMPTY marker as well as a named one — see the matching helper
  // in Home.test.tsx for why the data attribute alone cannot.
  function attributionElements(): Element[] {
    return Array.from(container.querySelectorAll('[title^="Uploaded by"]'));
  }

  function rowTitles(): string[] {
    return Array.from(container.querySelectorAll("span")).map((el) => el.textContent ?? "");
  }

  const withAttribution = (over: Partial<Track>): Track =>
    ({ ...track, ...over }) as Track;

  it("says \"you\" on the caller's own row and names the other member on theirs", () => {
    render(undefined, [
      withAttribution({ id: "t-mine", title: "mine", uploadedByMe: true, uploadedByName: "Nina" }),
      withAttribution({ id: "t-theirs", title: "theirs", uploadedByMe: false, uploadedByName: "Jimmy" }),
    ]);

    expect(rowTitles()).toContain("mine");
    expect(rowTitles()).toContain("theirs");
    expect(attributions()).toEqual(["you", "Jimmy"]);
  });

  it("renders no attribution when there is none — with the row still present", () => {
    render(undefined, [
      withAttribution({ id: "t-anon", title: "unattributed", uploadedByMe: false, uploadedByName: null }),
    ]);

    // Pins the row, so an empty list of names cannot be an empty list of rows.
    expect(rowTitles()).toContain("unattributed");
    expect(attributions()).toEqual([]);
    expect(attributionElements()).toHaveLength(0);
    expect(container.textContent).not.toContain("unknown");
  });
});
