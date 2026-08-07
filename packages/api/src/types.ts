import type { StorageBucket } from "./lib/storage.js";

export type User = {
  id: string;
  email: string;
  accent: string | null;
  // Null = owns this locker. Set = collaborator on that owner's locker.
  lockerOwnerId: string | null;
};

export type Bindings = {
  DB: unknown; // D1Database on Workers; "sqlite" sentinel on Node (factory ignores it)
  DEMOS_BUCKET: StorageBucket;
  MAX_PLAYLISTS?: string;
  MAX_STORAGE_BYTES?: string;
  MAX_COLLABORATORS?: string;
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
