// Node entry point for self-hosted deployments
// Usage: DATABASE_URL=... S3_ENDPOINT=... tsx src/server.ts

import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./db/schema.js";
import { setDbFactory } from "./db/index.js";
import { createS3Bucket } from "./lib/storage-s3.js";
import app from "./index.js";

// Use postgres driver for self-hosted (works with any Postgres instance)
setDbFactory((url: string) => {
  const client = postgres(url);
  return drizzle(client, { schema });
});

// S3-compatible storage
const bucket = createS3Bucket({
  endpoint: process.env.S3_ENDPOINT!,
  accessKeyId: process.env.S3_ACCESS_KEY!,
  secretAccessKey: process.env.S3_SECRET_KEY!,
  bucket: process.env.S3_BUCKET || "demos",
  region: process.env.S3_REGION || "auto",
});

// Inject Worker-style bindings from process.env
app.use("/*", async (c, next) => {
  (c as any).env = {
    DATABASE_URL: process.env.DATABASE_URL!,
    DEMOS_BUCKET: bucket,
    MAX_PLAYLISTS: process.env.MAX_PLAYLISTS,
    MAX_STORAGE_BYTES: process.env.MAX_STORAGE_BYTES,
    MAX_COLLABORATORS: process.env.MAX_COLLABORATORS,
  };
  return next();
});

const port = Number(process.env.PORT) || 3001;

serve({ fetch: app.fetch, port }, () => {
  console.log(`demo-locker api (self-hosted) running on :${port}`);
});
