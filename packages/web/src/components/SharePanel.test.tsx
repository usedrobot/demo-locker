// @vitest-environment happy-dom
//
// Covers minting share links with either permission and an optional label.
// Follows the house test pattern (createRoot + act, no @testing-library/react
// — not a dependency of this project). See TrackList.test.tsx /
// PlaylistView.rename.test.tsx for the same pattern.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import SharePanel from "./SharePanel";

vi.mock("../lib/api", () => ({
  shares: {
    forPlaylist: vi.fn(async () => ({ shares: [] })),
    create: vi.fn(async () => ({ share: {} })),
    revoke: vi.fn(async () => ({})),
  },
}));

import { shares as sharesApi } from "../lib/api";

const createMock = vi.mocked(sharesApi.create);
const forPlaylistMock = vi.mocked(sharesApi.forPlaylist);

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render() {
  act(() => {
    root.render(<SharePanel playlistId="pl-1" />);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function shareButton(): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    /share link/i.test(b.textContent ?? "")
  ) ?? null;
}

function editCheckbox(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(
    'input[type="checkbox"][aria-label*="upload and reorder" i]'
  );
}

function labelInput(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(
    'input[aria-label*="who is this for" i]'
  );
}

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value"
)!.set!;

function typeValue(input: HTMLInputElement, value: string) {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SharePanel", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ share: {} } as never);
    forPlaylistMock.mockReset();
    forPlaylistMock.mockResolvedValue({ shares: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("mints a listen link by default", async () => {
    render();
    await flush();

    act(() => shareButton()!.click());
    await flush();

    expect(createMock).toHaveBeenCalledWith("pl-1", "listen", undefined);
  });

  it("mints an edit link when the checkbox is checked", async () => {
    render();
    await flush();

    const checkbox = editCheckbox();
    expect(checkbox).not.toBeNull();
    act(() => checkbox!.click());
    act(() => shareButton()!.click());
    await flush();

    expect(createMock).toHaveBeenCalledWith("pl-1", "edit", undefined);
  });

  it("attaches the label so the link is identifiable later", async () => {
    render();
    await flush();

    const input = labelInput();
    expect(input).not.toBeNull();
    act(() => typeValue(input!, "Jimmy"));
    act(() => shareButton()!.click());
    await flush();

    expect(createMock).toHaveBeenCalledWith("pl-1", "listen", "Jimmy");
  });

  it("no longer points users at the access panel for edit access", async () => {
    render();
    await flush();

    expect(container.querySelector(".share-hint")).toBeNull();
  });
});

// COVERAGE CAVEAT: the 320px `.share-actions` overflow check is NOT covered
// by a unit test here. happy-dom has no layout engine — scrollWidth and
// clientWidth are always 0, so an assertion comparing them would pass
// unconditionally regardless of whether the row actually overflows. That is
// exactly the "test that passes whether or not the thing it guards exists"
// failure mode this branch has already hit once. The 320px check was instead
// done by measuring `.share-actions` in a real browser (see task-10-report.md
// for the recorded scrollWidth/clientWidth values).
