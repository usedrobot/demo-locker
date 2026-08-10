const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

let token: string | null = localStorage.getItem("token");

// Share/invite token for the anonymous invite flow. Not persisted — it lives
// only for the lifetime of an invite page view (set by Invite.tsx). Legacy
// gated endpoints accept it as EITHER a Bearer header (fetches) or a `?token=`
// query param (media elements). See packages/api/src/lib/playlist-access.ts.
let shareToken: string | null = null;

export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem("token", t);
  else localStorage.removeItem("token");
}

export function getToken() {
  return token;
}

export function setShareToken(t: string | null) {
  shareToken = t;
}

export function getShareToken() {
  return shareToken;
}

// The token to hang off media URLs (<audio>/<img>), which can't send headers.
// While an invite view is mounted, shareToken is set and MUST win over any
// (possibly stale, possibly foreign) session token sitting in localStorage —
// otherwise the gate gets the wrong credential and 404s the invite. Outside
// the invite view shareToken is always null, so this falls through to the
// session token with no change in behavior for the logged-in app.
function mediaToken(): string | null {
  return shareToken || token;
}

// Origin to use for public-facing URLs (embed snippets, public API links).
// For the split hosted deploy (Pages + Worker) the SPA origin != API origin,
// so prefer VITE_API_URL when set; fall back to same-origin for the
// standalone image where the web app is served alongside the API.
export function getApiOrigin(): string {
  return API_URL || window.location.origin;
}

// A failed request, carrying the status alongside the server's message.
//
// Callers used to have only the message string, which cannot distinguish "the
// network blipped, try again shortly" from "this session is over". Home's
// background refetch needs exactly that distinction: it stays silent on the
// first and must not stay silent on the second.
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// Whether a rejection means the session is over rather than the request having
// had bad luck. 401 is the API's answer to a missing or expired session; a
// fetch that never reached the server has no status at all and is not this.
export function isAuthFailure(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  // Share token (invite listener) wins whenever the invite view is mounted —
  // see mediaToken() above for why session token must not shadow it there.
  // shareToken is null outside the invite view, so logged-in requests are
  // unaffected. The API tries a Bearer token as both a session and a share
  // token, so either works.
  const authToken = shareToken || token;
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error || `request failed: ${res.status}`, res.status);
  }

  return res.json();
}

// Auth

// The signed-in account. `lockerOwnerId` is the locker this account belongs to
// as a COLLABORATOR; it is null for the person who owns the locker. That null
// is what "is this the owner?" means everywhere in the UI — owner-only surfaces
// (the collaborators panel) and the owner half of the delete rule
// (`uploadedByMe || isOwner`) both read it. /auth/signup, /auth/login and
// /auth/me all return it.
export type User = {
  id: string;
  email: string;
  accent: string | null;
  // The name this account's uploads and playlists are attributed to across the
  // locker (Track.uploadedByName, Playlist.createdByName). Null means unset,
  // and unset falls back to the email address above — which is why the settings
  // field says so. /auth/signup, /auth/login and /auth/me all return it.
  displayName: string | null;
  lockerOwnerId: string | null;
};

export const auth = {
  signup: (email: string, password: string, inviteToken?: string) =>
    request<{ user: User; token: string }>("/auth/signup", {
      method: "POST",
      // Omitted rather than sent as undefined when absent: an invite token is
      // its own authorisation to create an account on an instance where
      // registration is otherwise closed, and the API distinguishes "no token"
      // from "a token that isn't a string" (403).
      body: JSON.stringify(inviteToken ? { email, password, inviteToken } : { email, password }),
    }),
  login: (email: string, password: string) =>
    request<{ user: User; token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<{ user: User }>("/auth/me"),
  setAccent: (accent: string) =>
    request<{ accent: string }>("/auth/accent", {
      method: "POST",
      body: JSON.stringify({ accent }),
    }),
  // Name yourself. Open to any session, not just the owner: the owner never had
  // a name at all (they have no invite to take one from, so every row of theirs
  // showed their email), and a collaborator can correct a name the owner
  // mistyped when inviting them.
  //
  // Send "" to unset it — the API stores NULL and everything falls back to the
  // email again. The stored value comes back so the caller can show what was
  // actually saved, which is the trimmed string or null.
  setDisplayName: (displayName: string) =>
    request<{ displayName: string | null }>("/auth/display-name", {
      method: "POST",
      body: JSON.stringify({ displayName }),
    }),
  logout: () => request("/auth/logout", { method: "POST" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
};

// Playlists
export type Playlist = {
  id: string;
  name: string;
  ownerId: string;
  artworkKey: string | null;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
  // ATTRIBUTION, not permission: whether the requesting session created this
  // playlist. The raw creator id is never serialized (a locker may hold several
  // collaborators, and none may learn another's user id) — see
  // packages/api/src/lib/public-playlist.ts. The client rule for a delete
  // control is `createdByMe || isOwner`: the locker owner may delete anything
  // in the locker and gets false on every collaborator-created row.
  createdByMe: boolean;
  // WHO created it, by name — what createdByMe alone can never say once a
  // locker holds two people. Resolved server-side from the collaborator's
  // display name (the label the owner typed on their invite), falling back to
  // their email; the creator's user id is still never serialized. Null means
  // there is nothing to attribute — no creator recorded, or the reader has no
  // locker session (an anonymous share holder gets no names at all) — and must
  // render as nothing, never "unknown". Attribution, not permission.
  createdByName: string | null;
};

export type Track = {
  id: string;
  playlistId: string | null;
  title: string;
  position: number;
  // The API deliberately does not expose originalKey/streamKey — they are
  // bucket coordinates, and handing them to clients gave anyone who kept a copy
  // a durable handle on the object. `hasStream` is all the UI ever read them
  // for: whether the browser-side encode has landed yet.
  hasStream: boolean;
  waveformData: string | null;
  duration: number | null;
  uploadedAt: string;
  // ATTRIBUTION, not permission — the counterpart of Playlist.createdByMe. See
  // packages/api/src/lib/public-track.ts; the client rule for a delete control
  // is `uploadedByMe || isOwner`. False is ambiguous (no uploader recorded, or
  // no session to compare) and must never be rendered as "someone else
  // uploaded this".
  uploadedByMe: boolean;
  // WHO uploaded it, by name — the counterpart of Playlist.createdByName, with
  // the same rules: resolved server-side, no raw user id, null renders as
  // nothing. The acting user's own rows are rendered "you" rather than with
  // this name (see components/Attribution.tsx).
  uploadedByName: string | null;
};

export const playlists = {
  list: () => request<{ playlists: Playlist[] }>("/playlists"),
  get: (id: string) =>
    request<{ playlist: Playlist; tracks: Track[] }>(`/playlists/${id}`),
  create: (name: string) =>
    request<{ playlist: Playlist }>("/playlists", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  update: (id: string, data: Partial<Pick<Playlist, "name" | "artworkKey" | "isPublic">>) =>
    request<{ playlist: Playlist }>(`/playlists/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    request(`/playlists/${id}`, { method: "DELETE" }),
  reorder: (id: string, trackIds: string[]) =>
    request(`/playlists/${id}/reorder`, {
      method: "PATCH",
      body: JSON.stringify({ trackIds }),
    }),
  uploadArtwork: async (id: string, file: File): Promise<{ playlist: Playlist }> => {
    const formData = new FormData();
    formData.append("file", file);
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${API_URL}/playlists/${id}/artwork`, {
      method: "POST",
      headers,
      body: formData,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `upload failed: ${res.status}`);
    }
    return res.json();
  },
  artworkUrl: (id: string, artworkKey: string | null) => {
    if (!artworkKey) return null;
    const t = mediaToken();
    const auth = t ? `&token=${encodeURIComponent(t)}` : "";
    return `${API_URL}/playlists/${id}/artwork?v=${encodeURIComponent(artworkKey)}${auth}`;
  },
  artworkUrlUnchecked: (id: string) => {
    const t = mediaToken();
    const auth = t ? `?token=${encodeURIComponent(t)}` : "";
    return `${API_URL}/playlists/${id}/artwork${auth}`;
  },
};

// Tracks
export const tracks = {
  list: () => request<{ tracks: Track[] }>("/tracks"),
  attach: (id: string, playlistId: string | null) =>
    request<{ track: Track }>(`/tracks/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ playlistId }),
    }),
  upload: (
    playlistId: string | null,
    file: File,
    opts?: {
      title?: string;
      waveformData?: string;
      duration?: number;
      stream?: Blob;
      onProgress?: (pct: number) => void;
    }
  ): Promise<{ track: Track }> =>
    new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append("file", file);
      if (opts?.stream) formData.append("stream", opts.stream, `${file.name}.m4a`);
      if (playlistId) formData.append("playlistId", playlistId);
      if (opts?.title) formData.append("title", opts.title);
      if (opts?.waveformData) formData.append("waveformData", opts.waveformData);
      if (opts?.duration != null) formData.append("duration", String(opts.duration));

      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable && opts?.onProgress) {
          opts.onProgress(e.loaded / e.total);
        }
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error("invalid response"));
          }
        } else {
          let msg = `upload failed: ${xhr.status}`;
          try {
            const body = JSON.parse(xhr.responseText);
            if (body.error) msg = body.error;
          } catch {
            // ignore
          }
          reject(new Error(msg));
        }
      });
      xhr.addEventListener("error", () => reject(new Error("upload failed")));
      xhr.addEventListener("abort", () => reject(new Error("upload aborted")));
      xhr.open("POST", `${API_URL}/tracks/upload`);
      // share token first: on the invite page an edit link authorizes uploads
      const uploadToken = shareToken || token;
      if (uploadToken) xhr.setRequestHeader("Authorization", `Bearer ${uploadToken}`);
      xhr.send(formData);
    }),
  streamUrl: (id: string) => {
    const t = mediaToken();
    const auth = t ? `?token=${encodeURIComponent(t)}` : "";
    return `${API_URL}/tracks/${id}/stream${auth}`;
  },
  downloadUrl: (id: string) => {
    const t = mediaToken();
    const auth = t ? `?token=${encodeURIComponent(t)}` : "";
    return `${API_URL}/tracks/${id}/download${auth}`;
  },
  delete: (id: string) =>
    request(`/tracks/${id}`, { method: "DELETE" }),
};

// Comments
export type Comment = {
  id: string;
  trackId: string | null;
  playlistId: string | null;
  parentId: string | null;
  authorName: string;
  body: string;
  timestampSec: number | null;
  createdAt: string;
  resolvedAt: string | null;
  replies?: Comment[];
};

export const comments = {
  forTrack: (trackId: string) =>
    request<{ comments: Comment[] }>(`/comments/track/${trackId}`),
  forPlaylist: (playlistId: string) =>
    request<{ comments: Comment[] }>(`/comments/playlist/${playlistId}`),
  create: (data: {
    trackId?: string;
    playlistId?: string;
    authorName: string;
    body: string;
    timestampSec?: number;
    parentId?: string;
  }) =>
    request<{ comment: Comment & { deleteToken?: string } }>("/comments", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  resolve: (id: string) =>
    request<{ comment: Comment }>(`/comments/${id}/resolve`, {
      method: "PATCH",
    }),
  remove: (id: string, deleteToken?: string) =>
    request<{ ok: true }>(`/comments/${id}`, {
      method: "DELETE",
      headers: deleteToken ? { "X-Delete-Token": deleteToken } : undefined,
    }),
};

// Shares
export type Share = {
  id: string;
  playlistId: string;
  playlistName?: string;
  token: string;
  permission: "listen" | "edit";
  email: string | null;
  createdAt: string;
  expiresAt: string | null;
  // ATTRIBUTION, not permission — the same computed-boolean shape as
  // Track.uploadedByMe. Any member of the locker may revoke or re-permission
  // any link regardless of this flag; it exists so the owner can tell their own
  // links apart from ones a collaborator handed out. The minter's user id is
  // never serialized.
  mintedByMe: boolean;
};

export const shares = {
  create: (playlistId: string, permission: "listen" | "edit", email?: string) =>
    request<{ share: Share }>("/shares", {
      method: "POST",
      body: JSON.stringify({ playlistId, permission, email }),
    }),
  forPlaylist: (playlistId: string) =>
    request<{ shares: Share[] }>(`/shares/playlist/${playlistId}`),
  listAll: () => request<{ shares: Share[] }>("/shares"),
  setPermission: (id: string, permission: "listen" | "edit") =>
    request<{ share: Share }>(`/shares/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ permission }),
    }),
  revoke: (id: string) =>
    request(`/shares/${id}`, { method: "DELETE" }),
  resolveInvite: (token: string) =>
    request<{
      permission: string;
      playlist: Playlist;
      tracks: Track[];
      accent: string | null;
    }>(`/shares/invite/${token}`),
};

// Collaborators — the people who share this locker's library. Every route here
// is owner-only; a collaborator gets the same non-enumerable 404 a stranger
// does.
export type CollabInvite = {
  id: string;
  // Owner-supplied name for the person invited. NOT an email — nothing is
  // sent anywhere; the owner delivers the join link themselves.
  label: string;
  token: string;
  createdAt: string;
  // Null while the invite is still pending. A redeemed invite is spent: its
  // person now shows up under members instead.
  acceptedAt: string | null;
};

export type CollabMember = {
  id: string;
  email: string;
  // The name this person's uploads carry everywhere else in the app: the label
  // the owner typed when minting their invite. Null for anyone who redeemed
  // before display names existed — the email is the fallback, and stays here
  // regardless because this is the owner's member-management view.
  displayName: string | null;
  createdAt: string;
};

export const collab = {
  listInvites: () => request<{ invites: CollabInvite[] }>("/collab/invites"),
  invite: (label: string) =>
    request<{ invite: CollabInvite }>("/collab/invites", {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
  revokeInvite: (id: string) => request(`/collab/invites/${id}`, { method: "DELETE" }),
  listMembers: () => request<{ members: CollabMember[] }>("/collab/members"),
  // Removing a collaborator deletes their account: they are signed out, and
  // every share link they minted dies with them (the FK cascades). Their
  // uploads stay in the library and read as the owner's.
  removeMember: (id: string) => request(`/collab/members/${id}`, { method: "DELETE" }),
};
