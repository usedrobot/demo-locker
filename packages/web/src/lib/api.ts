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
    throw new Error(body.error || `request failed: ${res.status}`);
  }

  return res.json();
}

// Auth
export const auth = {
  signup: (email: string, password: string) =>
    request<{ user: { id: string; email: string }; token: string }>(
      "/auth/signup",
      { method: "POST", body: JSON.stringify({ email, password }) }
    ),
  login: (email: string, password: string) =>
    request<{ user: { id: string; email: string }; token: string }>(
      "/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) }
    ),
  me: () => request<{ user: { id: string; email: string } }>("/auth/me"),
  logout: () => request("/auth/logout", { method: "POST" }),
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
};

export type Track = {
  id: string;
  playlistId: string | null;
  title: string;
  position: number;
  originalKey: string;
  streamKey: string | null;
  waveformData: string | null;
  duration: number | null;
  uploadedAt: string;
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
      onProgress?: (pct: number) => void;
    }
  ): Promise<{ track: Track }> =>
    new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append("file", file);
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
  resolvedBy: string | null;
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
    request<{ permission: string; playlist: Playlist; tracks: Track[] }>(
      `/shares/invite/${token}`
    ),
};
