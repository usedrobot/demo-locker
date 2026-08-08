// @vitest-environment happy-dom
//
// What the moderation controls are gated on. The prop used to be called
// `isOwner`, and PlaylistView passed it the owner-only flag — so a
// collaborator, who may post a comment and may delete the whole playlist
// underneath it, could not resolve or delete a single one. The prop is now
// `canModerate` and carries the guarantee the API enforces: any member of the
// locker.
//
// House test pattern (createRoot + act, DOM queries by attribute selector) —
// @testing-library/react is NOT a dependency of this project. See
// CollabPanel.test.tsx for the same shape.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import Comments from "./Comments";
import type { Comment } from "../lib/api";

vi.mock("../lib/api", () => ({
  comments: {
    forTrack: vi.fn(async () => ({ comments: [] })),
    forPlaylist: vi.fn(async () => ({ comments: [] })),
    create: vi.fn(async () => ({ comment: {} })),
    resolve: vi.fn(async () => ({ comment: {} })),
    remove: vi.fn(async () => ({ ok: true })),
  },
}));

import { comments as api } from "../lib/api";

const forPlaylistMock = vi.mocked(api.forPlaylist);
const resolveMock = vi.mocked(api.resolve);

const comment: Comment = {
  id: "c-1",
  trackId: null,
  playlistId: "pl-1",
  parentId: null,
  authorName: "Listener",
  body: "needs a louder snare",
  timestampSec: null,
  createdAt: "",
  resolvedAt: null,
  resolvedBy: null,
  replies: [],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(props: { canModerate?: boolean } = {}) {
  act(() => {
    root.render(<Comments playlistId="pl-1" {...props} />);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Every negative assertion below pairs with this one: "no resolve control"
// must not be able to pass because the list rendered nothing at all.
function commentRows(): Element[] {
  return Array.from(container.querySelectorAll(".comment"));
}

function resolveButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    'button[title="Mark as resolved"], button[title="Mark as open"]'
  );
}

function deleteButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[title="Delete comment"]');
}

beforeEach(() => {
  // mockReset (not clearAllMocks) so any queued *Once value is drained too;
  // the defaults are re-armed immediately below.
  forPlaylistMock.mockReset();
  resolveMock.mockReset();
  forPlaylistMock.mockResolvedValue({ comments: [comment] });
  resolveMock.mockResolvedValue({ comment: { ...comment, resolvedAt: "now" } });
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("comment moderation controls", () => {
  it("offers resolve and delete to a moderator", async () => {
    render({ canModerate: true });
    await flush();

    expect(commentRows()).toHaveLength(1);
    expect(resolveButton()).not.toBeNull();
    expect(deleteButton()).not.toBeNull();
  });

  it("resolves through the API when the control is used", async () => {
    render({ canModerate: true });
    await flush();

    act(() => resolveButton()!.click());
    await flush();

    expect(resolveMock).toHaveBeenCalledWith("c-1");
  });

  it("withholds both from a non-moderator, on a comment that is on screen", async () => {
    render({ canModerate: false });
    await flush();

    // Pin the row first: without this the two nulls below would also be true
    // of an empty list.
    expect(commentRows()).toHaveLength(1);
    expect(container.textContent).toContain("needs a louder snare");
    expect(resolveButton()).toBeNull();
    expect(deleteButton()).toBeNull();
  });

  it("still lets an anonymous author delete their own comment without moderation rights", async () => {
    localStorage.setItem("commentDeleteTokens", JSON.stringify({ "c-1": "tok" }));
    render({ canModerate: false });
    await flush();

    expect(commentRows()).toHaveLength(1);
    expect(deleteButton()).not.toBeNull();
    // Their own comment, not the locker's — resolving is still not theirs.
    expect(resolveButton()).toBeNull();
  });
});
