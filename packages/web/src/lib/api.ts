const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

let token: string | null = localStorage.getItem("token");

export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem("token", t);
  else localStorage.removeItem("token");
}

export function getToken() {
  return token;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

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
  createdAt: string;
  updatedAt: string;
};

export type Track = {
  id: string;
  playlistId: string;
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
  update: (id: string, data: Partial<Pick<Playlist, "name" | "artworkKey">>) =>
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
  artworkUrl: (id: string, artworkKey: string | null) =>
    artworkKey ? `${API_URL}/playlists/${id}/artwork?v=${encodeURIComponent(artworkKey)}` : null,
  artworkUrlUnchecked: (id: string) => `${API_URL}/playlists/${id}/artwork`,
};

// Tracks
export const tracks = {
  upload: (
    playlistId: string,
    file: File,
    opts?: { title?: string; onProgress?: (pct: number) => void }
  ): Promise<{ track: Track }> =>
    new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("playlistId", playlistId);
      if (opts?.title) formData.append("title", opts.title);

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
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.send(formData);
    }),
  streamUrl: (id: string) => `${API_URL}/tracks/${id}/stream`,
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
    request<{ comment: Comment }>("/comments", {
      method: "POST",
      body: JSON.stringify(data),
    }),
};

// Shares
export type Share = {
  id: string;
  playlistId: string;
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
  revoke: (id: string) =>
    request(`/shares/${id}`, { method: "DELETE" }),
  resolveInvite: (token: string) =>
    request<{ permission: string; playlist: Playlist; tracks: Track[] }>(
      `/shares/invite/${token}`
    ),
};
