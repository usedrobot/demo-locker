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

// The permission checkbox. Matched on "re-arrange" — the capability an edit
// share actually grants. It used to say "upload and reorder", which was true
// of the old server behaviour and is not true of the new one: a share link
// cannot upload at all (api lib/playlist-access.ts).
function editCheckbox(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(
    'input[type="checkbox"][aria-label*="re-arrange" i]'
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

// Lets a test hold `create` open indefinitely and resolve (or reject) it on
// cue, to exercise behavior that only matters while a mint is genuinely in
// flight (as opposed to `mockResolvedValue`, which settles on the same
// microtask turn and never leaves an observable in-flight window). Mirrors
// the `deferred` helper in PlaylistView.rename.test.tsx.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Real browsers move focus to <body> when a focused control is disabled.
// happy-dom does NOT (verified directly in this environment, same as
// PlaylistView.rename.test.tsx's browserBlurOnDisable): after `.disabled =
// true`, `document.activeElement` is still the input. Tests that care about
// the refocus-after-disable behavior have to model that blur themselves.
function browserBlurOnDisable() {
  document.body.focus();
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
  //
  // Safari's composition-commit keydown is reported not to set isComposing at
  // all, so this guard may not cover it there — an unverified, deliberately
  // open gap. A `keyCode === 229` fallback previously stood in for it and was
  // removed: see the handler's comment in SharePanel.tsx for why re-adding it
  // (silent dead Enter on Android soft keyboards) is worse than the gap.
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

  it("announces the start and the completion of a mint as live-region text", async () => {
    const gate = deferred<Awaited<ReturnType<typeof sharesApi.create>>>();
    createMock.mockReturnValueOnce(gate.promise);

    render();
    await flush();

    // The region must already exist, empty, BEFORE the mint. Screen readers
    // commonly drop the announcement when a live region and its content are
    // inserted in the same commit, so a test asserting this is null at rest
    // (as an earlier version of this test did) pins the broken pattern.
    const idle = container.querySelector('[role="status"]');
    expect(idle).not.toBeNull();
    expect(idle!.textContent).toBe("");

    act(() => shareButton()!.click());
    await flush();

    // Same node, new text — a text CHANGE is what a live region announces.
    expect(container.querySelector('[role="status"]')).toBe(idle);
    expect(idle!.textContent).toBe("minting");

    await act(async () => {
      gate.resolve({ share: {} as never });
      await Promise.resolve();
    });
    await flush();

    // Completion must be its own text, not an emptied region. Emptying a
    // polite region announces NOTHING in NVDA/JAWS/VoiceOver, so a previous
    // version of this test — which asserted the node persisted and its text
    // went back to "" — could not tell "announced" from "silent" and passed
    // on the silent behaviour. Assert on what is actually said.
    expect(container.querySelector('[role="status"]')).toBe(idle);
    expect(idle!.textContent).toBe("share link created");
  });

  it("announces a failed mint via role=alert", async () => {
    createMock.mockRejectedValueOnce(new Error("nope"));

    render();
    await flush();

    expect(container.querySelector('[role="alert"]')).toBeNull();

    act(() => shareButton()!.click());
    await flush();

    // Without role=alert the error is a plain <div>: focus has already been
    // taken by the disable and silently handed back, so a screen-reader user
    // gets no signal at all that the mint failed.
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("nope");
  });

  it("does not steal focus into the label input merely by mounting", async () => {
    render();
    await flush();

    // Nothing disabled anything yet — `creating` has only ever been false —
    // so the refocus effect must not fire. Without the true -> false
    // transition guard, "focus is unclaimed" alone would be enough to grab
    // it the moment the component mounts.
    expect(document.activeElement).not.toBe(labelInput());
  });

  it("returns focus to the label input after a mint fails, so the correction isn't lost", async () => {
    const gate = deferred<Awaited<ReturnType<typeof sharesApi.create>>>();
    createMock.mockReturnValueOnce(gate.promise);

    render();
    await flush();

    const input = labelInput()!;
    act(() => input.focus());
    expect(document.activeElement).toBe(input);

    act(() => typeValue(input, "Jimmy"));
    // Enter in the field, not a button click: this test's premise is that the
    // user was *in the label input* when the mint started, which is the only
    // case the refocus effect is allowed to act on. Driving it by Enter keeps
    // that premise true in the DOM rather than relying on happy-dom happening
    // not to move focus on .click().
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(input.disabled).toBe(true);

    // See browserBlurOnDisable: happy-dom doesn't blur a disabled input on
    // its own, so this stands in for what a real browser does the instant
    // `disabled` becomes true.
    act(() => browserBlurOnDisable());
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      gate.reject(new Error("nope"));
      await gate.promise.catch(() => {});
    });
    await flush();

    expect(input.disabled).toBe(false);
    // The refocus effect fires because focus started in the label input and
    // was still unclaimed (on <body>) when `creating` flipped back to false.
    expect(document.activeElement).toBe(input);
  });

  // COVERAGE CAVEAT: the premise here is "a real browser blurs the mint button
  // to <body> when it becomes disabled, exactly as it does the label input."
  // happy-dom models neither half — it keeps activeElement on a disabled
  // element — so the test states that premise explicitly: it focuses the
  // button, then calls browserBlurOnDisable() at the point the browser would
  // already have blurred it. What is genuinely verified is that the effect
  // restores focus to *the control that had it when the mint started*.
  //
  // Note the assertion is `toBe(btn)`, not `not.toBe(input)`. The negative
  // form is what an earlier version asserted, and it passed for three
  // different outcomes — focus on the button (wanted), focus stranded on
  // <body> (the bug), or the refocus effect deleted outright — so it ratified
  // the stranded state as acceptable. Browsers do not restore focus to a
  // re-enabled element, so "stranded on <body>" is a real, permanent loss of
  // the user's tab position, not a transient.
  it("returns focus to the mint button when the mint started from the button", async () => {
    const gate = deferred<Awaited<ReturnType<typeof sharesApi.create>>>();
    createMock.mockReturnValueOnce(gate.promise);

    render();
    await flush();

    const input = labelInput()!;
    const btn = shareButton()!;
    act(() => btn.focus());
    expect(document.activeElement).toBe(btn);

    act(() => btn.click());
    await flush();

    act(() => browserBlurOnDisable());
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      gate.resolve({ share: {} as never });
      await Promise.resolve();
    });
    await flush();

    expect(document.activeElement).toBe(btn);
    expect(document.activeElement).not.toBe(input);
  });

  it("does not steal focus back if the user moved it elsewhere during the mint", async () => {
    const gate = deferred<Awaited<ReturnType<typeof sharesApi.create>>>();
    createMock.mockReturnValueOnce(gate.promise);

    render();
    await flush();

    const input = labelInput()!;
    act(() => input.focus());
    act(() => typeValue(input, "Jimmy"));
    act(() => shareButton()!.click());
    await flush();

    // Unlike the previous test: the user clicks something else (the
    // permission checkbox) while the mint is still in flight, instead of
    // focus merely reverting to <body> on its own.
    const checkbox = editCheckbox()!;
    act(() => checkbox.focus());
    expect(document.activeElement).toBe(checkbox);

    await act(async () => {
      gate.resolve({ share: {} as never });
      await Promise.resolve();
    });
    await flush();

    // Focus was claimed by something else, so the refocus effect must leave
    // it alone rather than yanking it back into the label input.
    expect(document.activeElement).toBe(checkbox);
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
