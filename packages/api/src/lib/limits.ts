// Free tier limits — only enforced on the hosted version.
// Self-hosted: leave these env vars unset for unlimited.

export const limits = {
  maxPlaylists: env("MAX_PLAYLISTS", 0), // 0 = unlimited
  maxStorageBytes: env("MAX_STORAGE_BYTES", 0),
  maxCollaborators: env("MAX_COLLABORATORS", 0),
};

function env(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

export function isLimited(limit: number): boolean {
  return limit > 0;
}
