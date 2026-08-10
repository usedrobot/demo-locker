import type { StorageBucket } from "./lib/storage.js";

export type User = {
  id: string;
  email: string;
  accent: string | null;
  // The name this account's uploads and playlists are attributed to, or null
  // for an account that has never set one — in which case the email is the
  // fallback (see lib/display-name.ts). Loaded with the session because the
  // settings field has to render the current value.
  displayName: string | null;
  // Null = owns this locker. Set = collaborator on that owner's locker.
  lockerOwnerId: string | null;
};

export type Bindings = {
  DB: unknown; // D1Database on Workers; "sqlite" sentinel on Node (factory ignores it)
  DEMOS_BUCKET: StorageBucket;
  MAX_PLAYLISTS?: string;
  MAX_STORAGE_BYTES?: string;
  // Seats in a locker: collaborators plus invites still outstanding.
  MAX_COLLABORATORS?: string;
  // Share links per playlist. Split out of MAX_COLLABORATORS in 0.2.13 —
  // one variable cannot mean both, and an operator raising the seat count
  // must not silently change how many links a playlist may have.
  MAX_SHARE_LINKS?: string;
  MAX_UPLOAD_BYTES?: string;
  // "true" reopens registration after the first account exists. Anything else
  // (including unset) means only the bootstrap signup is permitted.
  ALLOW_SIGNUP?: string;
  EMBED_JS?: string;
  OPENAPI_JSON?: string;
};

export type Env = {
  Bindings: Bindings;
  Variables: {
    user: User;
  };
};
