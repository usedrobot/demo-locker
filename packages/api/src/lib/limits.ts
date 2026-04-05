import type { Bindings } from "../types.js";

export function getLimits(env: Bindings) {
  return {
    maxPlaylists: parseInt(env.MAX_PLAYLISTS || "0", 10) || 0,
    maxStorageBytes: parseInt(env.MAX_STORAGE_BYTES || "0", 10) || 0,
    maxCollaborators: parseInt(env.MAX_COLLABORATORS || "0", 10) || 0,
  };
}

export function isLimited(limit: number): boolean {
  return limit > 0;
}
