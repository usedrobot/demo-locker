// Node entry point for self-hosted deployments.
// Zero-dependency mode: embedded SQLite + local-disk storage under DATA_DIR
// (default ./data); set S3_ENDPOINT to use S3 storage.

import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { setDbFactory } from "./db/index.js";
import { createSqliteDb } from "./db/sqlite.js";
import { createS3Bucket } from "./lib/storage-s3.js";
import { createFsBucket } from "./lib/storage-fs.js";
import type { StorageBucket } from "./lib/storage.js";
import app from "./index.js";

async function main() {
  const dataDir = process.env.DATA_DIR || "./data";

  // --- database ---
  // Always embedded sqlite; the file lives in the data volume next to the audio.
  const dbDir = join(dataDir, "db");
  await mkdir(dbDir, { recursive: true }); // fail fast if DATA_DIR unwritable
  const dbPath = join(dbDir, "demolocker.db");
  const sqliteDb = createSqliteDb(dbPath);
  setDbFactory(() => sqliteDb);
  console.log(`db: sqlite (${dbPath})`);

  // --- storage ---
  let bucket: StorageBucket;
  let storageIsZeroDep = false;
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
    storageIsZeroDep = true;
  }

  if (storageIsZeroDep) {
    console.warn(
      `⚠ storage is local disk — audio lives under ${dataDir}. ` +
        "Set S3_ENDPOINT to use S3.",
    );
  }

  const playerBundle = process.env.PLAYER_DIST || "../player/dist/embed.js";
  const embedJs = existsSync(playerBundle) ? readFileSync(playerBundle, "utf-8") : undefined;
  console.log(embedJs ? `embed: serving ${playerBundle}` : `embed: not serving (no build at ${playerBundle})`);

  const openapiPath = process.env.OPENAPI_PATH || "../../docs/openapi.json";
  const openapiJson = existsSync(openapiPath) ? readFileSync(openapiPath, "utf-8") : undefined;
  console.log(
    openapiJson ? `openapi: serving ${openapiPath}` : `openapi: not serving (no file at ${openapiPath})`,
  );

  // Worker-style bindings, passed to every request via app.fetch's env arg.
  // (Don't inject via app.use — index.ts registers routes at import time,
  // so any middleware added here would run after the route handlers.)
  const bindings = {
    DB: "sqlite", // sentinel — setDbFactory above ignores it and returns the shared db
    DEMOS_BUCKET: bucket,
    MAX_PLAYLISTS: process.env.MAX_PLAYLISTS,
    MAX_STORAGE_BYTES: process.env.MAX_STORAGE_BYTES,
    MAX_COLLABORATORS: process.env.MAX_COLLABORATORS,
    EMBED_JS: embedJs,
    OPENAPI_JSON: openapiJson,
  };

  // --- static web app (all-in-one mode) ---
  // Path is relative to the packages/api working directory.
  const webDist = process.env.WEB_DIST || "../web/dist";
  if (existsSync(webDist)) {
    app.use("*", serveStatic({ root: webDist }));
    // SPA fallback — GETs that matched no API route or file get index.html
    const indexHtml = readFileSync(join(webDist, "index.html"), "utf-8");
    app.notFound((c) => {
      if (c.req.path.startsWith("/assets/")) return c.text("not found", 404);
      if (c.req.method === "GET") return c.html(indexHtml);
      return c.text("not found", 404);
    });
    console.log(`web: serving ${webDist}`);
  } else {
    console.log(`web: not serving (no build at ${webDist})`);
  }

  const port = Number(process.env.PORT) || 3001;

  // index.ts (frozen, shared with the Workers build) stamps every response
  // with `Cache-Control: no-store` via a middleware that sets the header
  // *after* next() resolves. Because that middleware is registered before
  // the static-file serving added here, it is the outermost layer of the
  // onion and always runs its post-next code last — so any header we set
  // from a middleware registered in this file (including serveStatic's
  // onFound) gets clobbered by it (verified empirically). The only place
  // that runs strictly after the whole Hono middleware chain finishes is
  // this fetch wrapper, so hashed Vite assets get their cache header fixed
  // up here instead.
  async function fetchWithAssetCaching(request: Request): Promise<Response> {
    const response = await app.fetch(request, bindings);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.startsWith("/assets/") && response.ok) {
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  }

  serve({ fetch: fetchWithAssetCaching, port }, () => {
    console.log(`demo-locker api (self-hosted) running on :${port}`);
  });
}

main().catch((err) => {
  console.error("boot failed:", err);
  process.exit(1);
});
