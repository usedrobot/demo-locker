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

// Lets a test hold `create` open indefinitely and resolve it on cue, to
// exercise behavior that only matters while a mint is genuinely in flight
// (as opposed to `mockResolvedValue`, which settles on the same microtask
// turn and never leaves an observable in-flight window). Mirrors the
// `deferred` helper in PlaylistView.rename.test.tsx.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

    // Positive assertion alongside the negative one: without this, the test
    // would pass just as well if SharePanel rendered nothing at all, which
    // wouldn't verify the hint was removed so much as that some regression
    // happened to also remove it. The row and its controls have to actually
    // be there for the absence of .share-hint to mean what this test claims.
    expect(container.querySelector(".share-hint")).toBeNull();
    expect(container.querySelector(".share-actions")).not.toBeNull();
    expect(shareButton()).not.toBeNull();
    expect(editCheckbox()).not.toBeNull();
    expect(labelInput()).not.toBeNull();
  });

  it("resets the edit checkbox after a successful mint, like the label", async () => {
    render();
    await flush();

    const checkbox = editCheckbox();
    act(() => checkbox!.click());
    expect(checkbox!.checked).toBe(true);

    act(() => shareButton()!.click());
    await flush();

    // The label box clearing is the only visible "this form reset" signal.
    // If the checkbox stayed checked, that signal would be a lie: the next
    // link minted from this same row would silently inherit edit rights
    // nobody re-selected for it.
    expect(checkbox!.checked).toBe(false);
  });

  it("ignores a second click while a mint is still in flight", async () => {
    const gate = deferred<Awaited<ReturnType<typeof sharesApi.create>>>();
    createMock.mockReturnValueOnce(gate.promise);

    render();
    await flush();

    const btn = shareButton()!;
    // Both clicks happen inside one act() — i.e. in the same tick, before
    // React has re-rendered `disabled={creating}` into the DOM. That's the
    // scenario the disabled attribute alone can't cover: a fast double-click
    // lands both events before any render occurs, so only the synchronous
    // `creatingRef` guard (not the disabled prop) can dedupe it. Splitting
    // these into two separate act() calls would let a render land in between
    // and make the disabled attribute do the deduping instead, which would
    // pass even if creatingRef's own check were deleted.
    act(() => {
      btn.click();
      btn.click();
    });

    expect(createMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve({ share: {} as never });
      await Promise.resolve();
    });
  });

  it("mints on Enter in the label input, not just on click", async () => {
    render();
    await flush();

    const input = labelInput();
    act(() => typeValue(input!, "Jimmy"));
    act(() => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    await flush();

    expect(createMock).toHaveBeenCalledWith("pl-1", "listen", "Jimmy");
  });

  // COVERAGE CAVEAT: happy-dom does not implement a real IME composition
  // pipeline, so this doesn't reproduce an actual composition session — it
  // constructs a KeyboardEvent with isComposing set per the KeyboardEventInit
  // spec (the same property a real browser sets on the keydown that commits
  // an IME candidate) and checks the handler respects it. It cannot catch a
  // regression in how a *real* IME's compositionend/keydown ordering
  // interacts with this handler, only whether the isComposing check itself
  // is present and wired up.
  it("does not mint on the Enter that commits an IME composition", async () => {
    render();
    await flush();

    const input = labelInput();
    act(() => typeValue(input!, "日本"));
    act(() => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
        })
      );
    });
    await flush();

    expect(createMock).not.toHaveBeenCalled();
  });

  it("does not mint again for a held-Enter repeat once the first mint has resolved", async () => {
    render();
    await flush();

    const input = labelInput();
    act(() => typeValue(input!, "Jimmy"));
    act(() => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    await flush();
    expect(createMock).toHaveBeenCalledTimes(1);

    // creatingRef has already cleared by now (the first mint resolved), so
    // only the `repeat` check — not the in-flight guard — can stop this one.
    act(() => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true })
      );
    });
    await flush();

    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("disables the label input while a mint is in flight", async () => {
    const gate = deferred<Awaited<ReturnType<typeof sharesApi.create>>>();
    createMock.mockReturnValueOnce(gate.promise);

    render();
    await flush();

    const input = labelInput();
    expect(input!.disabled).toBe(false);

    act(() => shareButton()!.click());
    // A render is expected between the click and this check — unlike the
    // dedupe test, this one is about the rendered `disabled` attribute
    // itself, not about beating a render to the punch.
    await flush();

    expect(input!.disabled).toBe(true);

    await act(async () => {
      gate.resolve({ share: {} as never });
      await Promise.resolve();
    });
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
