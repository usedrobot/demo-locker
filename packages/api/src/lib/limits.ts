import type { Bindings } from "../types.js";

// Hard ceilings that apply on every deployment, limit bindings or not. The
// env-configurable limits below are an operator's tighter policy on top; these
// exist so an instance with nothing configured still can't be filled up by a
// single request.
export const MAX_ARTWORK_BYTES = 10 * 1024 * 1024; // 10MB
export const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1GB per file
export const MAX_COMMENT_BODY_CHARS = 5000;
export const MAX_COMMENT_AUTHOR_CHARS = 100;

export function getLimits(env: Bindings) {
  return {
    maxPlaylists: parseInt(env.MAX_PLAYLISTS || "0", 10) || 0,
    maxStorageBytes: parseInt(env.MAX_STORAGE_BYTES || "0", 10) || 0,
    // Seats in a locker (members + outstanding invites), enforced in
    // routes/collab.ts.
    maxCollaborators: parseInt(env.MAX_COLLABORATORS || "0", 10) || 0,
    // Share links on one playlist, enforced in routes/shares.ts. These two
    // were the same binding until 0.2.13, which meant an operator allowing
    // three bandmates also capped every playlist at three links and got a
    // 403 about share links they had never configured.
    maxShareLinks: parseInt(env.MAX_SHARE_LINKS || "0", 10) || 0,
    // Per-file ceiling. Falls back to the built-in rather than to "unlimited",
    // because MAX_STORAGE_BYTES spent four releases documented-but-unenforced
    // and the lesson is that an unset limit should still be a limit.
    maxUploadBytes:
      parseInt(env.MAX_UPLOAD_BYTES || "0", 10) || DEFAULT_MAX_UPLOAD_BYTES,
  };
}

export function isLimited(limit: number): boolean {
  return limit > 0;
}
