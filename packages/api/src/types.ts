import type { StorageBucket } from "./lib/storage.js";

export type User = {
  id: string;
  email: string;
};

export type Bindings = {
  DB: unknown; // D1Database on Workers; "sqlite" sentinel on Node (factory ignores it)
  DEMOS_BUCKET: StorageBucket;
  MAX_PLAYLISTS?: string;
  MAX_STORAGE_BYTES?: string;
  MAX_COLLABORATORS?: string;
  EMBED_JS?: string;
  OPENAPI_JSON?: string;
};

export type Env = {
  Bindings: Bindings;
  Variables: {
    user: User;
  };
};
