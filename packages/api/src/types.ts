import type { StorageBucket } from "./lib/storage.js";

export type User = {
  id: string;
  email: string;
};

export type Bindings = {
  DATABASE_URL: string;
  DEMOS_BUCKET: StorageBucket;
  MAX_PLAYLISTS?: string;
  MAX_STORAGE_BYTES?: string;
  MAX_COLLABORATORS?: string;
};

export type Env = {
  Bindings: Bindings;
  Variables: {
    user: User;
  };
};
