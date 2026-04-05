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
};

// Tracks
export const tracks = {
  getUploadUrl: (playlistId: string, filename: string, contentType: string) =>
    request<{ uploadUrl: string; track: Track }>("/tracks/upload-url", {
      method: "POST",
      body: JSON.stringify({ playlistId, filename, contentType }),
    }),
  confirm: (id: string) =>
    request(`/tracks/${id}/confirm`, { method: "POST" }),
  streamUrl: (id: string) =>
    request<{ url: string }>(`/tracks/${id}/stream`),
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
