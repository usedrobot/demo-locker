// @vitest-environment happy-dom
//
// Reorder used to rewrite the list on every dragover and fire a PATCH per row
// crossed. Those requests raced, so the server sometimes kept an intermediate
// order — DL: "jumpy and not super accurate and messes up order sometimes".
//
// The contract now: a drag produces exactly ONE onReorder, on drop, with the
// final order. Driven by keyboard because that path is deterministic in a DOM
// without layout; pointer and keyboard share the same drop handler.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import TrackList from "./TrackList";
import type { Track } from "../lib/api";

vi.mock("../lib/api", () => ({
  tracks: { downloadUrl: (id: string) => `/tracks/${id}/download` },
  playlists: { removeTrack: vi.fn(async () => ({ ok: true })) },
}));
vi.mock("../lib/audio", () => ({
  player: {
    getState: () => ({ track: null, playlistId: null, playing: false, duration: 0, currentTime: 0 }),
    subscribe: () => () => {},
    play: vi.fn(),
    clear: vi.fn(),
  },
}));

const list = ["a", "b", "c"].map(
  (id) => ({ id, title: `Song ${id.toUpperCase()}`, duration: 100, hasStream: true }) as unknown as Track,
);

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const realRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // happy-dom has no layout. Give each row a 40px slot so the sortable
  // keyboard coordinates have somewhere to move to.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const row = this.closest("[data-track-row]");
    // Anything that is not a row (the list itself) spans the whole page, so
    // restrictToParentElement has room to move a row within it.
    const top = row ? Number(row.getAttribute("data-track-row")) * 40 : 0;
    const height = row ? 40 : 1000;
    return { x: 0, y: top, top, left: 0, right: 500, bottom: top + height, width: 500, height, toJSON() {} } as DOMRect;
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Element.prototype.getBoundingClientRect = realRect;
});

function render(onReorder?: (ids: string[]) => void) {
  act(() => {
    root.render(<TrackList tracks={list} playlistId="p1" onReorder={onReorder} />);
  });
}

function handle(title: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="Reorder ${title}"]`);
}

async function key(el: Element, code: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { code, key: code === "Space" ? " " : code, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("TrackList reorder", () => {
  it("gives each row a labelled drag handle", () => {
    render(() => {});
    expect(handle("Song A")).not.toBeNull();
    expect(handle("Song C")).not.toBeNull();
  });

  it("calls onReorder once, on drop, with the final order", async () => {
    const onReorder = vi.fn();
    render(onReorder);
    const h = handle("Song A")!;
    h.focus();
    await key(h, "Space");
    await key(document.activeElement ?? h, "ArrowDown");
    await key(document.activeElement ?? h, "ArrowDown");
    expect(onReorder, "reordered mid-drag — that is what raced the server").not.toHaveBeenCalled();
    await key(document.activeElement ?? h, "Space");
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(["b", "c", "a"]);
  });

  it("does not call onReorder when a drag is cancelled", async () => {
    const onReorder = vi.fn();
    render(onReorder);
    const h = handle("Song A")!;
    h.focus();
    await key(h, "Space");
    await key(document.activeElement ?? h, "ArrowDown");
    await key(document.activeElement ?? h, "Escape");
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("renders no handle for a reader who cannot reorder", () => {
    // Listen-only share links used to get a grab cursor on a list that could
    // not move.
    render(undefined);
    expect(handle("Song A")).toBeNull();
    expect(container.textContent).toContain("Song A");
  });
});
