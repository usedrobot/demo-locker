// Node entry point for self-hosted deployments.
// Zero-dependency mode: with no DATABASE_URL / S3_ENDPOINT set, runs on
// embedded PGlite + local-disk storage under DATA_DIR (default ./data).

import { existsSync, statSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./db/schema.js";
import { setDbFactory } from "./db/index.js";
import { createPgliteDb } from "./db/pglite.js";
import { createS3Bucket } from "./lib/storage-s3.js";
import { createFsBucket } from "./lib/storage-fs.js";
import type { StorageBucket } from "./lib/storage.js";
import app from "./index.js";

async function main() {
  const dataDir = process.env.DATA_DIR || "./data";

  // --- database ---
  let databaseUrl: string;
  if (process.env.DATABASE_URL) {
    databaseUrl = process.env.DATABASE_URL;
    setDbFactory((url: string) => {
      const client = postgres(url);
      return drizzle(client, { schema });
    });
    console.log("db: postgres (DATABASE_URL)");
  } else {
    const dbDir = join(dataDir, "db");
    await mkdir(dbDir, { recursive: true }); // fail fast if DATA_DIR unwritable
    const pgliteDb = await createPgliteDb(dbDir);
    // getDb caches per url string; the sentinel keeps the cache stable
    databaseUrl = "pglite";
    setDbFactory(() => pgliteDb);
    console.log(`db: pglite (${dbDir}) — set DATABASE_URL to use Postgres`);
  }

  // --- storage ---
  let bucket: StorageBucket;
  if (process.env.S3_ENDPOINT) {
    bucket = createS3Bucket({
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
      bucket: process.env.S3_BUCKET || "demos",
      region: process.env.S3_REGION || "auto",
    });
    console.log(`storage: s3 (${process.env.S3_ENDPOINT})`);
  } else {
    const audioDir = join(dataDir, "audio");
    await mkdir(audioDir, { recursive: true }); // fail fast if DATA_DIR unwritable
    bucket = createFsBucket(audioDir);
    console.log(`storage: local disk (${audioDir}) — set S3_ENDPOINT to use S3`);
  }

  // Inject Worker-style bindings from process.env
  app.use("/*", async (c, next) => {
    (c as any).env = {
      DATABASE_URL: databaseUrl,
      DEMOS_BUCKET: bucket,
      MAX_PLAYLISTS: process.env.MAX_PLAYLISTS,
      MAX_STORAGE_BYTES: process.env.MAX_STORAGE_BYTES,
      MAX_COLLABORATORS: process.env.MAX_COLLABORATORS,
    };
    return next();
  });

  // --- static web app (all-in-one mode) ---
  // Path is relative to the packages/api working directory.
  const webDist = process.env.WEB_DIST || "../web/dist";
  if (existsSync(webDist)) {
    // Serve static files if they exist; otherwise continue to SPA fallback
    app.use("*", async (c, next) => {
      const requestPath = c.req.path === "/" ? "/index.html" : c.req.path;
      const filePath = join(webDist, requestPath);
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        return await serveStatic({ root: webDist })(c, next);
      }
      return next();
    });
    // SPA fallback — only reached when no API route or file matched
    app.get("*", (c) => {
      const indexPath = join(webDist, "index.html");
      const html = readFileSync(indexPath, "utf-8");
      return c.html(html);
    });
    console.log(`web: serving ${webDist}`);
  } else {
    console.log(`web: not serving (no build at ${webDist})`);
  }

  const port = Number(process.env.PORT) || 3001;

  serve({ fetch: app.fetch, port }, () => {
    console.log(`demo-locker api (self-hosted) running on :${port}`);
  });
}

main().catch((err) => {
  console.error("boot failed:", err);
  process.exit(1);
});
