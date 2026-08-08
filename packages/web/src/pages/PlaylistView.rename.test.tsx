// @vitest-environment happy-dom
//
// Covers the rename control added to PlaylistView: commit on Enter, discard
// on Escape, and refuse to submit a blank/whitespace name. Follows the house
// test pattern (createRoot + act, no @testing-library/react — not a
// dependency of this project).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

// Lets a test hold a PATCH open indefinitely and resolve it on cue, to
// exercise behavior that only matters while a request is genuinely in
// flight (as opposed to `mockResolvedValue`, which settles on the same
// microtask turn and never leaves an observable in-flight window).
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
// happy-dom does NOT: after `.disabled = true`, `document.activeElement` is
// still the input. Both quirks below were verified directly in this
// environment rather than assumed:
//   1. disabling a focused input leaves it as document.activeElement;
//   2. calling .blur() on an already-disabled input is a no-op, so the
//      obvious way to model quirk 1 doesn't work either — moving focus
//      explicitly (document.body.focus()) is what actually shifts it.
// Any test that cares about focus across the in-flight window has to do this
// itself, or it asserts against a focus state no browser is ever in. Named
// for the browser behaviour it stands in for, not for its mechanism.
function browserBlurOnDisable() {
  document.body.focus();
}

// Each test mounts into a fresh container. Without this teardown the previous
// container stays in document.body with its React tree still mounted, so state
// that lives on the *document* — notably document.activeElement — leaks into
// later tests. That leak is invisible in a green run but makes full-file
// mutation runs lie: killing one guard appears to break three unrelated tests.
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("playlist rename", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks clears recorded calls but NOT queued *Once values. Several
    // tests below queue one with mockReturnValueOnce/mockRejectedValueOnce; if
    // such a test aborts on a failed assertion before consuming it, the queued
    // value survives into the next test — which then gets, say, a promise that
    // never settles, and fails for a reason that has nothing to do with what it
    // asserts. mockReset drains the queue; the defaults are re-stubbed on the
    // next two lines. (Only these two: resetting the mocks whose implementation
    // comes from the vi.mock factory would wipe it and leave them undefined.)
    getMock.mockReset();
    updateMock.mockReset();
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
  // exercise the handler — a bare .blur() call alone won't reach it. This
  // dispatch happens while `input` is still attached to `container` and
  // still the rendered node (nothing has committed or unmounted it yet), so
  // the delegated listener on the root actually receives it — a genuine
  // exercise of onBlur, not just a same-named event fired into a void.
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

  // Regression for a real browser sequence: Chrome/Safari do NOT fire
  // blur/focusout when a focused element is removed from the DOM, so a
  // blur dispatched against an already-unmounted input (as an earlier
  // version of this test did) never reaches React's delegated listener —
  // it proves nothing either way. The real risk is a blur that arrives
  // *before* the in-flight commit resolves (the input is still mounted
  // then): the user hits Enter, then clicks something else before the PATCH
  // response lands. Both events are dispatched inside one `act` so the
  // mocked PATCH's promise has no chance to resolve in between — the input
  // is provably still mounted when the second commitRename() call is made.
  it("does not fire a duplicate PATCH when a blur arrives before an in-flight commit resolves", async () => {
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
      // Still synchronous with the Enter above — commitRename has only run
      // as far as its `await api.update(...)` line, so the input has not
      // unmounted and this focusout reaches a live, mounted node.
      expect(nameInput()).toBe(input);
      input!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flush();

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith("pl-1", { name: "new name" });
  });

  // Regression for the bug this exact guard reintroduced once already:
  // Escape sets a one-shot ref telling the next blur "discard, don't
  // commit" — but real browsers (Chrome, Safari) never fire that blur when
  // Escape's own setRenaming(false) unmounts the input, so nothing ever
  // consumed it. A later, unrelated rename session's legitimate blur-commit
  // would see the stale flag and be silently discarded. The fix resets the
  // flag when the editor opens; this test never dispatches a blur after
  // Escape (deliberately — a real browser wouldn't either) so it can only
  // pass if that open-time reset is doing the work.
  it("does not let a stale Escape-cancel from a prior session swallow a later commit", async () => {
    render();
    await flush();

    // First session: type something, then Escape. No blur is dispatched —
    // this mirrors a real browser, which would not fire one here.
    act(() => renameButton()!.click());
    act(() => typeValue(nameInput()!, "abandoned"));
    act(() => {
      nameInput()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    await flush();
    expect(updateMock).not.toHaveBeenCalled();

    // Second, unrelated session: reopen, type a real edit, click away.
    act(() => renameButton()!.click());
    const input = nameInput();
    act(() => typeValue(input!, "second session name"));
    act(() => {
      input!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flush();

    expect(updateMock).toHaveBeenCalledWith("pl-1", { name: "second session name" });
  });

  // The editor does not stay editable across the request window. Letting the
  // user keep typing during a PATCH meant either dropping the correction or
  // running a retry loop that could commit half-typed text; disabling the
  // field for the (usually brief) request instead makes the window
  // uneditable, so there is nothing to drop and nothing to reconcile. It
  // also makes the in-flight Escape no-op below legible rather than
  // mysterious: the user can see the field is not accepting input.
  //
  // COVERAGE CAVEAT: this asserts the rendered `disabled` attribute and the
  // affordance, nothing about focus. happy-dom leaves a disabled input as
  // document.activeElement, where a real browser moves focus to <body> — so
  // the focus state during this test is not the one a user is ever in. The
  // focus consequences are covered by the refocus test below, which models
  // that blur explicitly.
  it("disables the input and shows a pending affordance while the rename is in flight", async () => {
    const first = deferred<{ playlist: Playlist }>();
    updateMock.mockReturnValueOnce(first.promise);

    render();
    await flush();

    act(() => renameButton()!.click());
    const input = nameInput()!;
    expect(input.disabled).toBe(false);

    act(() => typeValue(input, "slow one"));
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    await flush();

    // The request is out and has not resolved: the field is still mounted,
    // still holds the draft, and is not editable.
    expect(updateMock).toHaveBeenCalledTimes(1);
    const pending = nameInput();
    expect(pending).not.toBeNull();
    expect(pending!.disabled).toBe(true);
    expect(pending!.value).toBe("slow one");
    expect(container.textContent).toContain("saving");

    act(() => first.resolve({ playlist: { ...playlist, name: "slow one" } }));
    await flush();

    // Success closes the editor and takes the pending affordance with it.
    expect(nameInput()).toBeNull();
    expect(container.textContent).not.toContain("saving");
  });

  // The re-enabled field has to be reachable from the keyboard, which is a
  // stronger claim than "not disabled". Disabling a focused input moves focus
  // to <body>, and autoFocus cannot re-fire on an element that never
  // unmounted — so without an explicit refocus the user sees their draft and
  // the error, types the correction, and the keystrokes go to the document.
  // Enter does nothing, Escape does nothing, and [rename] is hidden while
  // renaming, so there is no visible way back in.
  //
  // COVERAGE CAVEAT: happy-dom does not blur on disable (see
  // browserBlurOnDisable above), so this test performs that blur itself. It
  // proves the refocus happens given the browser's focus behaviour; it cannot
  // prove happy-dom reproduces that behaviour, because it doesn't.
  it("returns focus to the input after a failed rename, and re-arms blur-commit", async () => {
    const first = deferred<{ playlist: Playlist }>();
    updateMock.mockReturnValueOnce(first.promise);

    render();
    await flush();

    act(() => renameButton()!.click());
    const input = nameInput()!;
    // Opening the editor focuses it — the same effect that restores focus later.
    expect(document.activeElement).toBe(input);

    act(() => typeValue(input, "taken name"));
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    await flush();
    expect(input.disabled).toBe(true);

    act(() => browserBlurOnDisable());
    expect(document.activeElement).not.toBe(input);

    act(() => first.reject(new Error("name already taken")));
    await flush();

    // Same node (never unmounted), enabled again — and actually focused, so a
    // typed correction lands in the field rather than on <body>.
    expect(nameInput()).toBe(input);
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);

    // Focus being back is also what re-arms the blur-commit safety net: with
    // the field blurred and never refocused, no further blur could fire from
    // it, so clicking [make public] (still rendered during renaming) or
    // [< back] after a failure would take the draft to the grave.
    act(() => typeValue(input, "free name"));
    act(() => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flush();

    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenNthCalledWith(2, "pl-1", { name: "free name" });
  });

  // The property this whole task has been protecting: a failed rename must
  // never cost the user their typed name. On failure the field comes back to
  // life with the draft still in it and the error visible, so the fix is a
  // correction-and-retry rather than a retype from scratch.
  //
  // COVERAGE CAVEAT: the retry below is driven by a dispatched keydown, which
  // reaches React's handler regardless of where focus actually is. In a real
  // browser the field would have been blurred by the disable, so this test on
  // its own would pass even with the correction going nowhere — the focus
  // half of the claim is the refocus test's job, not this one's.
  it("re-enables the input with the draft intact when the rename fails", async () => {
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

    const input = nameInput();
    expect(input).not.toBeNull();
    expect(input!.disabled).toBe(false);
    expect(input!.value).toBe("taken name");
    expect(container.textContent).toContain("name already taken");
    expect(container.textContent).not.toContain("saving");

    // And the retry actually goes out — the field is genuinely live again,
    // not merely rendered without the attribute.
    act(() => typeValue(input!, "free name"));
    act(() => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    await flush();

    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenNthCalledWith(2, "pl-1", { name: "free name" });
  });

  // Regression: Escape used to close the editor unconditionally, including
  // while a PATCH from an earlier Enter was still in flight — the UI said
  // "cancelled" while the request completed and the rename landed anyway.
  // The request can't actually be recalled, so Escape must not pretend it
  // can: while a commit is outstanding, Escape is a no-op and the editor
  // stays open until that request resolves for real.
  it("does not let Escape discard a rename that is already in flight", async () => {
    const first = deferred<{ playlist: Playlist }>();
    updateMock.mockReturnValueOnce(first.promise);

    render();
    await flush();

    act(() => renameButton()!.click());
    const input = nameInput()!;
    act(() => typeValue(input, "in flight"));
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    expect(updateMock).toHaveBeenCalledTimes(1);

    // Escape while that request is still out.
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    await flush();
    // Not discarded: the editor is still open, and no second (cancelling)
    // request was fired. It is also visibly disabled, which is what makes
    // the no-op legible instead of the key just seeming to be ignored.
    expect(nameInput()).not.toBeNull();
    expect(nameInput()!.disabled).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);

    act(() => first.resolve({ playlist: { ...playlist, name: "in flight" } }));
    await flush();

    // The request that Escape couldn't actually stop completes, and the
    // editor closes reflecting it — no silent divergence between what the
    // UI showed and what the server actually did.
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(nameInput()).toBeNull();
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
    getMock.mockReset();
    updateMock.mockReset();
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
