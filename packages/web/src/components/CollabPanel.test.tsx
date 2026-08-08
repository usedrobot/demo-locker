// @vitest-environment happy-dom
//
// The collaborators panel: who shares this locker, who has been invited, and
// the controls that add and remove them.
//
// House test pattern (createRoot + act, DOM queries by attribute selector) —
// @testing-library/react is NOT a dependency of this project. See
// TrackList.test.tsx and SharePanel.test.tsx for the same shape.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import CollabPanel from "./CollabPanel";

vi.mock("../lib/api", () => ({
  collab: {
    listInvites: vi.fn(async () => ({ invites: [] })),
    listMembers: vi.fn(async () => ({ members: [] })),
    invite: vi.fn(async () => ({ invite: {} })),
    revokeInvite: vi.fn(async () => ({})),
    removeMember: vi.fn(async () => ({})),
  },
}));

vi.mock("../lib/copy-text", () => ({
  copyText: vi.fn(async () => true),
}));

import { collab } from "../lib/api";
import { copyText } from "../lib/copy-text";

const listInvitesMock = vi.mocked(collab.listInvites);
const listMembersMock = vi.mocked(collab.listMembers);
const inviteMock = vi.mocked(collab.invite);
const revokeInviteMock = vi.mocked(collab.revokeInvite);
const removeMemberMock = vi.mocked(collab.removeMember);
const copyTextMock = vi.mocked(copyText);

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render() {
  act(() => {
    root.render(<CollabPanel />);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonMatching(pattern: RegExp): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((b) =>
      pattern.test(b.textContent ?? "")
    ) ?? null
  );
}

function nameInput(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('input[aria-label="name"]');
}

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value"
)!.set!;

function typeValue(input: HTMLInputElement, value: string) {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// Lets a test hold a mutation open and settle it on cue, so behaviour that only
// exists while a request is genuinely in flight is observable. Mirrors the
// `deferred` helper in SharePanel.test.tsx.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Real browsers move focus to <body> the instant a focused control becomes
// disabled. happy-dom does NOT (same caveat as SharePanel.test.tsx /
// PlaylistView.rename.test.tsx: activeElement stays on the disabled element),
// so tests about refocus-after-disable have to model that blur themselves.
function browserBlurOnDisable() {
  document.body.focus();
}

const INVITE = {
  id: "i-1",
  label: "Jimmy",
  token: "tok123",
  createdAt: "2026-08-07T00:00:00.000Z",
  acceptedAt: null,
};

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CollabPanel", () => {
  beforeEach(() => {
    // mockReset, not clearAllMocks: clearing does not drain *Once queues or
    // undo a mockResolvedValue left behind by a previous test.
    listInvitesMock.mockReset();
    listInvitesMock.mockResolvedValue({ invites: [] });
    listMembersMock.mockReset();
    listMembersMock.mockResolvedValue({ members: [] });
    inviteMock.mockReset();
    inviteMock.mockResolvedValue({ invite: INVITE });
    revokeInviteMock.mockReset();
    revokeInviteMock.mockResolvedValue({});
    removeMemberMock.mockReset();
    removeMemberMock.mockResolvedValue({});
    copyTextMock.mockReset();
    copyTextMock.mockResolvedValue(true);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("mints an invite with the typed label", async () => {
    render();
    await flush();

    act(() => typeValue(nameInput()!, "Jimmy"));
    act(() => buttonMatching(/invite/i)!.click());
    await flush();

    expect(inviteMock).toHaveBeenCalledWith("Jimmy");
  });

  it("will not mint an unlabelled invite", async () => {
    render();
    await flush();

    act(() => buttonMatching(/invite/i)!.click());
    await flush();

    expect(inviteMock).not.toHaveBeenCalled();
  });

  it("will not mint an invite labelled with only whitespace", async () => {
    render();
    await flush();

    // A space is enough to make the button look armed, and the server refuses
    // it with a 400 — so the refusal belongs here, before the round trip.
    act(() => typeValue(nameInput()!, "   "));
    act(() => buttonMatching(/invite/i)!.click());
    await flush();

    expect(inviteMock).not.toHaveBeenCalled();
  });

  it("lists members with a remove control", async () => {
    listMembersMock.mockResolvedValue({
      members: [{ id: "m-1", email: "jimmy@band.dev", createdAt: "" }],
    });

    render();
    await flush();

    expect(container.textContent).toContain("jimmy@band.dev");
    expect(buttonMatching(/remove/i)).not.toBeNull();
  });

  it("removes a member only on the second click of the confirm", async () => {
    listMembersMock.mockResolvedValue({
      members: [{ id: "m-1", email: "jimmy@band.dev", createdAt: "" }],
    });

    render();
    await flush();

    act(() => buttonMatching(/^\[remove\]$/)!.click());
    // Removing a collaborator deletes their account — the two-step confirm is
    // the house pattern for exactly this kind of irreversible control.
    expect(removeMemberMock).not.toHaveBeenCalled();
    expect(buttonMatching(/^\[remove\?\]$/)).not.toBeNull();

    act(() => buttonMatching(/^\[remove\?\]$/)!.click());
    await flush();

    expect(removeMemberMock).toHaveBeenCalledWith("m-1");
  });

  it("shows pending invites but not redeemed ones", async () => {
    listInvitesMock.mockResolvedValue({
      invites: [
        INVITE,
        { ...INVITE, id: "i-2", label: "Redeemed Rita", acceptedAt: "2026-08-07T01:00:00.000Z" },
      ],
    });
    // A redeemed invite's person shows up as a member instead; listing the
    // spent invite too would read as a second, still-usable way in.
    listMembersMock.mockResolvedValue({
      members: [{ id: "m-2", email: "rita@band.dev", createdAt: "" }],
    });

    render();
    await flush();

    expect(container.textContent).toContain("Jimmy");
    expect(container.textContent).not.toContain("Redeemed Rita");
  });

  it("copies a join link built from the invite token", async () => {
    listInvitesMock.mockResolvedValue({ invites: [INVITE] });

    render();
    await flush();

    act(() => buttonMatching(/copy link/i)!.click());
    await flush();

    // copyText, not navigator.clipboard: the latter is undefined outside a
    // secure context, and plain-http self-hosts are a supported path.
    expect(copyTextMock).toHaveBeenCalledWith(`${window.location.origin}/join/tok123`);
  });

  it("revokes a pending invite only on the second click of the confirm", async () => {
    listInvitesMock.mockResolvedValue({ invites: [INVITE] });

    render();
    await flush();

    act(() => buttonMatching(/^\[revoke\]$/)!.click());
    expect(revokeInviteMock).not.toHaveBeenCalled();

    act(() => buttonMatching(/^\[revoke\?\]$/)!.click());
    await flush();

    expect(revokeInviteMock).toHaveBeenCalledWith("i-1");
  });

  it("reloads both lists after a mutation", async () => {
    render();
    await flush();
    expect(listInvitesMock).toHaveBeenCalledTimes(1);
    expect(listMembersMock).toHaveBeenCalledTimes(1);

    act(() => typeValue(nameInput()!, "Jimmy"));
    act(() => buttonMatching(/invite/i)!.click());
    await flush();

    // The new invite has to appear in the list without a manual refresh —
    // the token in that row is the only copy of the link.
    expect(listInvitesMock).toHaveBeenCalledTimes(2);
    expect(listMembersMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a failed mint rather than failing silently", async () => {
    inviteMock.mockRejectedValueOnce(new Error("this instance limits lockers to 3 collaborators"));

    render();
    await flush();

    act(() => typeValue(nameInput()!, "Jimmy"));
    act(() => buttonMatching(/invite/i)!.click());
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("limits lockers to 3 collaborators");
  });

  it("surfaces a failed load rather than rendering an empty locker", async () => {
    listMembersMock.mockRejectedValueOnce(new Error("network down"));

    render();
    await flush();

    // An empty members list and a failed request look identical on screen
    // otherwise — and "nobody is in your locker" is a dangerous thing to say
    // wrongly.
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("network down");
  });

  it("clears a previous failure when the next invite is attempted", async () => {
    listMembersMock.mockRejectedValueOnce(new Error("network down"));

    render();
    await flush();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    act(() => typeValue(nameInput()!, "Jimmy"));
    act(() => buttonMatching(/invite/i)!.click());
    await flush();

    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("ignores a second click while an invite is still in flight", async () => {
    const gate = deferred<{ invite: typeof INVITE }>();
    inviteMock.mockReturnValueOnce(gate.promise);

    render();
    await flush();

    act(() => typeValue(nameInput()!, "Jimmy"));
    const btn = buttonMatching(/invite/i)!;
    // Both clicks inside ONE act(), i.e. before React re-renders `disabled`
    // into the DOM — the case only a synchronous ref guard can dedupe.
    act(() => {
      btn.click();
      btn.click();
    });

    expect(inviteMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve({ invite: INVITE });
      await Promise.resolve();
    });
    await flush();
  });

  it("returns focus to the name input after an invite fails, so the correction isn't lost", async () => {
    const gate = deferred<{ invite: typeof INVITE }>();
    inviteMock.mockReturnValueOnce(gate.promise);

    render();
    await flush();

    const input = nameInput()!;
    act(() => input.focus());
    act(() => typeValue(input, "Jimmy"));
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(input.disabled).toBe(true);

    // See browserBlurOnDisable: happy-dom keeps activeElement on a disabled
    // element, so this stands in for what a real browser already did.
    act(() => browserBlurOnDisable());
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      gate.reject(new Error("nope"));
      await gate.promise.catch(() => {});
    });
    await flush();

    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  // COVERAGE CAVEAT: the premise — "a real browser blurs the invite button to
  // <body> the moment it becomes disabled" — is NOT modelled by happy-dom, so
  // this test states it explicitly via browserBlurOnDisable(). What is
  // genuinely verified is that focus is restored to the control that had it
  // when the invite started, rather than to a hardcoded default.
  it("returns focus to the invite button when the invite started from the button", async () => {
    const gate = deferred<{ invite: typeof INVITE }>();
    inviteMock.mockReturnValueOnce(gate.promise);

    render();
    await flush();

    const input = nameInput()!;
    act(() => typeValue(input, "Jimmy"));
    const btn = buttonMatching(/invite/i)!;
    act(() => btn.focus());
    act(() => btn.click());
    await flush();

    act(() => browserBlurOnDisable());

    await act(async () => {
      gate.resolve({ invite: INVITE });
      await Promise.resolve();
    });
    await flush();

    // toBe(btn), not not.toBe(input): the negative form also passes when focus
    // is stranded on <body>, which is a permanent loss of tab position —
    // browsers do not restore focus to a re-enabled element.
    expect(document.activeElement).toBe(btn);
  });

  it("does not steal focus back if the user moved it during the invite", async () => {
    const gate = deferred<{ invite: typeof INVITE }>();
    inviteMock.mockReturnValueOnce(gate.promise);

    render();
    await flush();

    const input = nameInput()!;
    act(() => input.focus());
    act(() => typeValue(input, "Jimmy"));
    act(() => buttonMatching(/invite/i)!.click());
    await flush();

    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    act(() => elsewhere.focus());

    await act(async () => {
      gate.resolve({ invite: INVITE });
      await Promise.resolve();
    });
    await flush();

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("does not steal focus into the name input merely by mounting", async () => {
    render();
    await flush();

    // Nothing has ever been disabled, so the refocus effect must not fire.
    expect(document.activeElement).not.toBe(nameInput());
  });
});
