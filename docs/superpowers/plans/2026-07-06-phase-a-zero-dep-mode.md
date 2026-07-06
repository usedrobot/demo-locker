# Phase A: Zero-Dependency Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demo Locker runs as a single container with zero external services — PGlite instead of Postgres, local disk instead of S3, web app served by the API — plus deploy templates and a beginner hosting guide.

**Architecture:** Driver selection by absence of config: no `DATABASE_URL` → embedded PGlite persisting under `DATA_DIR`; no `S3_ENDPOINT` → new local-disk driver behind the existing `StorageBucket` interface. A new `standalone` Docker target bundles the API and the built web app (built same-origin) into one image with a single `/data` volume. The Cloudflare Worker deploy path and the existing Postgres+S3 compose path are untouched.

**Tech Stack:** Node 22, Hono 4, Drizzle ORM 0.45.2, `@electric-sql/pglite`, vitest, Docker.

**Spec:** `docs/superpowers/specs/2026-07-06-oss-direction-and-phase-a-design.md`

**Corrections vs. spec (verified against code 2026-07-06):**
- The spec's "existing API test suite" does not exist. Task 1 introduces vitest.
- There is no transcoding — `tracks.ts:56` serves originals (`streamKey = originalKey`). No ffmpeg in the image; the smoke test uploads and streams, no transcode step.

## Global Constraints

- **No schema changes.** `packages/api/src/db/schema.ts` must not change. (Task 2 syncs migration *files* to the schema; it does not alter the schema.)
- **Do not modify** `packages/api/src/lib/storage.ts` (the `StorageBucket` interface) or `packages/api/src/index.ts` (shared Worker/Node app).
- The Worker deploy path must keep passing `npm run typecheck` (tsc covers both entry points).
- Existing env-driven deployments (Postgres+S3 compose, Cloudflare) must behave identically when their env vars are set.
- All code TypeScript ESM (`"type": "module"`, `.js` import suffixes as in existing code).
- Commit messages: conventional commits, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Vitest setup + local-disk storage driver

**Files:**
- Modify: `packages/api/package.json` (add vitest, test script)
- Create: `packages/api/vitest.config.ts`
- Create: `packages/api/src/lib/storage-fs.ts`
- Test: `packages/api/src/lib/storage-fs.test.ts`

**Interfaces:**
- Consumes: `StorageBucket`, `StorageObject` from `./storage.js` (existing, unchanged).
- Produces: `createFsBucket(root: string): StorageBucket` — used by Task 3 in `server.ts`.

- [ ] **Step 1: Install vitest and add config**

```bash
npm install -D vitest -w packages/api
```

Add to `packages/api/package.json` scripts:

```json
"test": "vitest run"
```

Create `packages/api/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Write the failing tests**

Create `packages/api/src/lib/storage-fs.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBucket } from "./storage-fs.js";

async function streamToBuffer(stream: ReadableStream): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

describe("createFsBucket", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dl-fs-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a put/get with content type and size", async () => {
    const bucket = createFsBucket(root);
    const data = Buffer.from("hello demo locker");
    await bucket.put("pl1/track1/song.wav", data, {
      httpMetadata: { contentType: "audio/wav" },
    });

    const obj = await bucket.get("pl1/track1/song.wav");
    expect(obj).not.toBeNull();
    expect(obj!.size).toBe(data.length);
    expect(obj!.httpMetadata?.contentType).toBe("audio/wav");
    expect((await streamToBuffer(obj!.body)).toString()).toBe("hello demo locker");
  });

  it("accepts ArrayBuffer and ReadableStream bodies", async () => {
    const bucket = createFsBucket(root);
    const bytes = new TextEncoder().encode("stream body");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    await bucket.put("a/ab.bin", bytes.buffer as ArrayBuffer);
    await bucket.put("a/stream.bin", stream);

    expect((await streamToBuffer((await bucket.get("a/ab.bin"))!.body)).toString()).toBe("stream body");
    expect((await streamToBuffer((await bucket.get("a/stream.bin"))!.body)).toString()).toBe("stream body");
  });

  it("serves range reads", async () => {
    const bucket = createFsBucket(root);
    await bucket.put("k", Buffer.from("0123456789"));

    const obj = await bucket.get("k", { range: { offset: 2, length: 4 } });
    expect((await streamToBuffer(obj!.body)).toString()).toBe("2345");
    // size is the FULL object size (matches S3 driver semantics used by the
    // stream route to compute Content-Range)
    expect(obj!.size).toBe(10);
  });

  it("returns null for a missing key", async () => {
    const bucket = createFsBucket(root);
    expect(await bucket.get("nope")).toBeNull();
  });

  it("deletes objects", async () => {
    const bucket = createFsBucket(root);
    await bucket.put("gone", Buffer.from("x"));
    await bucket.delete("gone");
    expect(await bucket.get("gone")).toBeNull();
    // deleting again is a no-op, not an error
    await bucket.delete("gone");
  });

  it("rejects path-traversal keys", async () => {
    const bucket = createFsBucket(root);
    await expect(bucket.put("../evil", Buffer.from("x"))).rejects.toThrow(/invalid storage key/);
    await expect(bucket.get("../../etc/passwd")).rejects.toThrow(/invalid storage key/);
    await expect(bucket.delete("a/../../evil")).rejects.toThrow(/invalid storage key/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test -w packages/api
```

Expected: FAIL — `Cannot find module './storage-fs.js'` (or equivalent resolution error).

- [ ] **Step 4: Implement the driver**

Create `packages/api/src/lib/storage-fs.ts`:

```ts
// Local-disk storage for zero-dependency self-hosting.
// Content type is persisted in a "<file>.dlmeta" JSON sidecar.

import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { StorageBucket, StorageObject } from "./storage.js";

export function createFsBucket(root: string): StorageBucket {
  const rootAbs = resolve(root);

  function pathFor(key: string): string {
    const p = resolve(rootAbs, key);
    if (p !== rootAbs && !p.startsWith(rootAbs + sep)) {
      throw new Error(`invalid storage key: ${key}`);
    }
    return p;
  }

  return {
    async put(key, body, options) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });

      let buf: Buffer;
      if (body instanceof Buffer) {
        buf = body;
      } else if (body instanceof ArrayBuffer) {
        buf = Buffer.from(body);
      } else {
        const chunks: Uint8Array[] = [];
        const reader = body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        buf = Buffer.concat(chunks);
      }

      await writeFile(path, buf);
      const contentType = options?.httpMetadata?.contentType;
      if (contentType) {
        await writeFile(`${path}.dlmeta`, JSON.stringify({ contentType }));
      }
    },

    async get(key, options) {
      const path = pathFor(key);

      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        return null;
      }

      let contentType: string | undefined;
      try {
        contentType = JSON.parse(await readFile(`${path}.dlmeta`, "utf8")).contentType;
      } catch {
        // no sidecar — content type unknown
      }

      const nodeStream = options?.range
        ? createReadStream(path, {
            start: options.range.offset,
            end: options.range.offset + options.range.length - 1,
          })
        : createReadStream(path);

      return {
        body: Readable.toWeb(nodeStream) as unknown as ReadableStream,
        size,
        httpMetadata: { contentType },
      } as StorageObject;
    },

    async delete(key) {
      const path = pathFor(key);
      await unlink(path).catch(() => {});
      await unlink(`${path}.dlmeta`).catch(() => {});
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -w packages/api
```

Expected: PASS (6 tests). Also run `npm run typecheck` — expected clean.

- [ ] **Step 6: Commit**

```bash
git add packages/api/package.json packages/api/vitest.config.ts packages/api/src/lib/storage-fs.ts packages/api/src/lib/storage-fs.test.ts package-lock.json
git commit -m "feat(api): local-disk storage driver + vitest setup"
```

---

### Task 2: Sync Drizzle migration files with the schema

**Files:**
- Create: `packages/api/src/db/migrations/0001_*.sql` (generated)
- Modify: `packages/api/src/db/migrations/meta/*` (generated)

**Interfaces:**
- Consumes: `packages/api/src/db/schema.ts` (read-only), `packages/api/drizzle.config.ts` (existing).
- Produces: a migrations folder that fully reproduces the current schema — Task 3's boot-time `migrate()` depends on this.

**Context:** `comments.resolved_at`, `comments.resolved_by`, and `comments.delete_token` exist in `schema.ts` and in production (added via raw `ALTER TABLE`) but are missing from `migrations/0000_*.sql`. A fresh PGlite database built from migrations alone would be missing them.

- [ ] **Step 1: Generate the catch-up migration**

```bash
cd packages/api && npx drizzle-kit generate
```

Expected: a new `src/db/migrations/0001_<name>.sql` containing ONLY `ALTER TABLE "comments" ADD COLUMN ...` statements for `resolved_at` (timestamp), `resolved_by` (uuid or text — must match `schema.ts`), and `delete_token` (text).

- [ ] **Step 2: Inspect the generated SQL**

```bash
cat src/db/migrations/0001_*.sql
```

If it contains anything beyond the three `comments` columns, STOP — there is additional schema/migration drift. Report what was generated and wait for review before committing.

- [ ] **Step 3: Do NOT apply to production**

Production Neon already has these columns. This migration only matters for fresh databases (PGlite installs, new self-hosts). No `db push`, no manual apply.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/db/migrations
git commit -m "chore(db): sync migration files with schema (comments resolve/delete columns)"
```

---

### Task 3: PGlite driver, boot-time migration, and driver selection in server.ts

**Files:**
- Modify: `packages/api/package.json` (add `@electric-sql/pglite`)
- Create: `packages/api/src/db/pglite.ts`
- Test: `packages/api/src/db/pglite.test.ts`
- Modify: `packages/api/src/server.ts` (rewrite — full file below)

**Interfaces:**
- Consumes: `setDbFactory(factory)` / `getDb(url)` from `db/index.js` (existing — note `getDb` caches on the `url` string, so PGlite mode passes the constant sentinel `"pglite"` through `c.env.DATABASE_URL`); `createFsBucket(root)` from Task 1.
- Produces: `createPgliteDb(dataDir?: string): Promise<Database>` — in-memory when `dataDir` is omitted (tests), persistent otherwise. `server.ts` boot behavior that Tasks 4–5 extend.

- [ ] **Step 1: Install PGlite**

```bash
npm install @electric-sql/pglite -w packages/api
```

- [ ] **Step 2: Write the failing test**

Create `packages/api/src/db/pglite.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createPgliteDb } from "./pglite.js";
import { users, comments } from "./schema.js";

describe("createPgliteDb", () => {
  it("boots an in-memory db, runs migrations, and round-trips a row", async () => {
    const db = await createPgliteDb(); // no dataDir → in-memory

    const [user] = await db
      .insert(users)
      .values({ email: "pglite@test.dev", passwordHash: "x" })
      .returning();
    expect(user.id).toBeTruthy();

    const found = await db.select().from(users).where(eq(users.email, "pglite@test.dev"));
    expect(found).toHaveLength(1);
  });

  it("has the migration-drift columns from 0001 (comments.resolved_at etc.)", async () => {
    const db = await createPgliteDb();
    // insert exercising the columns that only exist if migration 0001 ran
    const [row] = await db
      .insert(comments)
      .values({ authorName: "t", body: "b", deleteToken: "tok" })
      .returning();
    expect(row.deleteToken).toBe("tok");
  });
});
```

Note: if `comments` has NOT NULL references (e.g. requires `trackId`/`playlistId`), adjust the second test's `values` to satisfy them by first inserting a user + playlist — check `schema.ts` and keep the assertion on `deleteToken`.

- [ ] **Step 3: Run test to verify it fails**

```bash
npm test -w packages/api
```

Expected: FAIL — `Cannot find module './pglite.js'`.

- [ ] **Step 4: Implement `createPgliteDb`**

Create `packages/api/src/db/pglite.ts`:

```ts
// Embedded Postgres (PGlite) for zero-dependency self-hosting.
// Same Postgres dialect as Neon/postgres-js — one schema, one migration set.

import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.js";
import type { Database } from "./index.js";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

export async function createPgliteDb(dataDir?: string): Promise<Database> {
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return db;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -w packages/api
```

Expected: PASS. (First run downloads/initializes PGlite WASM — a few seconds is normal.)

- [ ] **Step 6: Rewrite server.ts with driver selection**

Replace `packages/api/src/server.ts` in full:

```ts
// Node entry point for self-hosted deployments.
// Zero-dependency mode: with no DATABASE_URL / S3_ENDPOINT set, runs on
// embedded PGlite + local-disk storage under DATA_DIR (default ./data).

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
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

  const port = Number(process.env.PORT) || 3001;

  serve({ fetch: app.fetch, port }, () => {
    console.log(`demo-locker api (self-hosted) running on :${port}`);
  });
}

main().catch((err) => {
  console.error("boot failed:", err);
  process.exit(1);
});
```

- [ ] **Step 7: Verify both modes boot**

```bash
# zero-dep mode
cd packages/api && rm -rf /tmp/dl-zerodep && DATA_DIR=/tmp/dl-zerodep npx tsx src/server.ts &
sleep 5 && curl -s http://localhost:3001/health
kill %1
```

Expected: boot logs show `db: pglite (/tmp/dl-zerodep/db)` and `storage: local disk (/tmp/dl-zerodep/audio)`; health returns `{"status":"ok",...}`.

```bash
npm run typecheck && npm test -w packages/api
```

Expected: clean + all tests pass. (Postgres+S3 mode is exercised unchanged by the compose path; the code path with env vars set is identical to before except for log lines.)

- [ ] **Step 8: Commit**

```bash
git add packages/api/package.json packages/api/src/db/pglite.ts packages/api/src/db/pglite.test.ts packages/api/src/server.ts package-lock.json
git commit -m "feat(api): zero-dep mode — PGlite + local-disk drivers selected by env absence"
```

---

### Task 4: Same-origin web build + static serving from the Node server

**Files:**
- Modify: `packages/web/src/lib/api.ts:1`
- Modify: `packages/api/src/server.ts` (add static serving block)

**Interfaces:**
- Consumes: the `main()` structure from Task 3.
- Produces: `WEB_DIST` env contract (path relative to `packages/api` cwd, default `../web/dist`) — the Task 5 image relies on it; web builds with `VITE_API_URL=""` produce same-origin fetches.

- [ ] **Step 1: Make the web API base honor an empty string**

In `packages/web/src/lib/api.ts` line 1, change `||` to `??` so `VITE_API_URL=""` means "same origin" instead of falling back to localhost:

```ts
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
```

(Existing deploys are unaffected: unset still yields the localhost fallback, and the CI pages deploy sets a full URL.)

- [ ] **Step 2: Serve the built web app from server.ts**

In `packages/api/src/server.ts`, add to the imports:

```ts
import { existsSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
```

Then insert this block in `main()` AFTER the env-injection middleware and BEFORE the `serve(...)` call:

```ts
  // --- static web app (all-in-one mode) ---
  // Path is relative to the packages/api working directory.
  const webDist = process.env.WEB_DIST || "../web/dist";
  if (existsSync(webDist)) {
    app.use("*", serveStatic({ root: webDist }));
    // SPA fallback — only reached when no API route or file matched
    app.get("*", serveStatic({ path: join(webDist, "index.html") }));
    console.log(`web: serving ${webDist}`);
  } else {
    console.log(`web: not serving (no build at ${webDist})`);
  }
```

(Registered last, so it only handles requests no API route matched. The SPA has exactly two routes — `/` and `/invite/:token` — neither collides with an API path.)

- [ ] **Step 3: Verify end-to-end locally**

```bash
VITE_API_URL="" npm run build -w packages/web
cd packages/api && rm -rf /tmp/dl-zerodep && DATA_DIR=/tmp/dl-zerodep npx tsx src/server.ts &
sleep 5
curl -s http://localhost:3001/health          # → {"status":"ok",...}
curl -s http://localhost:3001/ | head -3       # → <!doctype html> ... (the SPA)
curl -s http://localhost:3001/invite/abc123 | head -3  # → SPA fallback, same html
kill %1
```

Expected output as annotated. Then `npm run typecheck` — clean.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/lib/api.ts packages/api/src/server.ts
git commit -m "feat: serve web app from the Node server; support same-origin API via VITE_API_URL=\"\""
```

---

### Task 5: All-in-one Docker image + smoke test script

**Files:**
- Modify: `Dockerfile` (append two stages)
- Create: `scripts/smoke.sh`
- Modify: `README.md` (Quick Start section)

**Interfaces:**
- Consumes: `standalone` env contract from Tasks 3–4 (`DATA_DIR`, `WEB_DIST`).
- Produces: the `standalone` build target and `scripts/smoke.sh` — Task 6 CI and Task 7 templates depend on both.

- [ ] **Step 1: Add the standalone stages to Dockerfile**

Append to `Dockerfile`:

```dockerfile
# --- Standalone web build (same-origin API) ---
FROM base AS standalone-web-build
COPY packages/web packages/web
WORKDIR /app/packages/web
ENV VITE_API_URL=""
RUN npm run build

# --- Standalone: API + web + embedded db, one container, one volume ---
FROM base AS standalone
COPY packages/api packages/api
COPY --from=standalone-web-build /app/packages/web/dist packages/web/dist
WORKDIR /app/packages/api
ENV DATA_DIR=/data
ENV WEB_DIST=../web/dist
VOLUME /data
EXPOSE 3001
CMD ["npx", "tsx", "src/server.ts"]
```

- [ ] **Step 2: Write the smoke script**

Create `scripts/smoke.sh` (requires `docker`, `curl`, `jq`, `python3`):

```bash
#!/usr/bin/env bash
# Smoke test for the standalone image: build, boot, sign up, upload,
# range-stream, comment, restart, verify persistence.
set -euo pipefail

IMAGE="${IMAGE:-demo-locker-standalone:smoke}"
PORT="${PORT:-3401}"
BASE="http://localhost:${PORT}"

docker build --target standalone -t "$IMAGE" .

cleanup() {
  docker rm -f dl-smoke >/dev/null 2>&1 || true
  docker volume rm dl-smoke-data >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker volume create dl-smoke-data >/dev/null
docker run -d --name dl-smoke -v dl-smoke-data:/data -p "${PORT}:3001" "$IMAGE" >/dev/null

wait_healthy() {
  for _ in $(seq 1 60); do
    if curl -fsS "$BASE/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "FAIL: server never became healthy"; docker logs dl-smoke; exit 1
}
wait_healthy

echo "→ signup"
TOKEN=$(curl -fsS -X POST "$BASE/auth/signup" \
  -H 'Content-Type: application/json' \
  -d '{"email":"smoke@test.dev","password":"smoketest123"}' | jq -re .token)

echo "→ create playlist"
PLAYLIST_ID=$(curl -fsS -X POST "$BASE/playlists" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"smoke"}' | jq -re .playlist.id)

echo "→ upload track"
python3 - <<'EOF'
import struct
data = b"\x00" * 3200
with open("/tmp/dl-smoke.wav", "wb") as f:
    f.write(b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 16000, 2, 16)
            + b"data" + struct.pack("<I", len(data)) + data)
EOF
TRACK_ID=$(curl -fsS -X POST "$BASE/tracks/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/tmp/dl-smoke.wav;type=audio/wav" \
  -F "playlistId=$PLAYLIST_ID" | jq -re .track.id)

echo "→ range stream"
STATUS=$(curl -fsS -o /dev/null -w '%{http_code}' -H "Range: bytes=0-99" \
  "$BASE/tracks/$TRACK_ID/stream")
[ "$STATUS" = "206" ] || { echo "FAIL: expected 206, got $STATUS"; exit 1; }

echo "→ comment"
curl -fsS -X POST "$BASE/comments" \
  -H 'Content-Type: application/json' \
  -d "{\"trackId\":\"$TRACK_ID\",\"authorName\":\"smoke\",\"body\":\"sounds rough. ship it.\",\"timestampSec\":0.1}" \
  | jq -re .comment.id >/dev/null || { echo "FAIL: comment"; exit 1; }

echo "→ SPA served"
curl -fsS "$BASE/" | grep -qi "<!doctype html" || { echo "FAIL: no SPA at /"; exit 1; }

echo "→ restart container, verify persistence"
docker restart dl-smoke >/dev/null
wait_healthy
curl -fsS "$BASE/playlists" -H "Authorization: Bearer $TOKEN" \
  | jq -re '.playlists[] | select(.name=="smoke") | .id' >/dev/null \
  || { echo "FAIL: playlist did not survive restart"; exit 1; }

echo "SMOKE OK"
```

```bash
chmod +x scripts/smoke.sh
```

Note: the comment-response shape (`.comment.id`) and playlist-list shape (`.playlists[]`) must match `routes/comments.ts` / `routes/playlists.ts` — verify the actual `c.json(...)` return keys while implementing and adjust the `jq` paths if they differ.

- [ ] **Step 3: Run the smoke test**

```bash
./scripts/smoke.sh
```

Expected: each `→` line prints, then `SMOKE OK`. If the session-token auth or response shapes differ, fix the script (not the API).

- [ ] **Step 4: Update README Quick Start**

Replace the README "Quick Start" section body with:

````markdown
## Quick Start

One container, zero external services — database and audio files live in a single volume:

```bash
docker run -d -v demolocker:/data -p 3001:3001 ghcr.io/usedrobot/demo-locker:latest
```

Open `http://localhost:3001`. That's the whole stack.

For development, or to run against your own Postgres + S3, see below.
````

Keep the existing compose instructions under Self-Host, noting they're the Postgres+S3 path.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile scripts/smoke.sh README.md
git commit -m "feat: all-in-one standalone Docker image + smoke test"
```

---

### Task 6: CI — test job, smoke job, GHCR image publish

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm test -w packages/api` (Task 1), `scripts/smoke.sh` (Task 5).
- Produces: `ghcr.io/usedrobot/demo-locker:latest` published on main — referenced by Task 5's README and Task 7's templates.

- [ ] **Step 1: Add test + smoke jobs and GHCR publish**

In `.github/workflows/ci.yml`, add after the `check` job (same indentation level):

```yaml
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm install
      - run: npm test -w packages/api

  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/smoke.sh

  publish-image:
    needs: [check, test, smoke]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          target: standalone
          push: true
          tags: |
            ghcr.io/usedrobot/demo-locker:latest
            ghcr.io/usedrobot/demo-locker:${{ github.sha }}
```

Also update the two existing deploy jobs to gate on tests: change `needs: check` to `needs: [check, test]` in `deploy-api` and `deploy-web`.

- [ ] **Step 2: Verify workflow syntax locally**

```bash
npx --yes yaml-lint .github/workflows/ci.yml 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml ok')"
```

Expected: `yaml ok` (or lint pass).

- [ ] **Step 3: Commit and push, watch CI**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run api tests + standalone smoke test; publish standalone image to GHCR"
git push
gh run watch
```

Expected: all jobs green, `publish-image` pushes to GHCR. (First publish may need the package's visibility set to public in the GitHub UI afterward — note this for DL if pulls fail anonymously.)

---

### Task 7: Deploy templates (Fly.io, Railway, Coolify)

**Files:**
- Create: `fly.toml`
- Create: `railway.json`
- Create: `docs/deploy-templates.md`

**Interfaces:**
- Consumes: the `standalone` Docker target (Task 5).
- Produces: templates referenced by the hosting guide (Task 8).

- [ ] **Step 1: Fly.io config**

Create `fly.toml`:

```toml
# Fly.io deploy for the standalone (zero-dependency) image.
# Usage: fly launch --copy-config --no-deploy && fly volumes create data --size 3 && fly deploy
app = "demo-locker"
primary_region = "mia"

[build]
  dockerfile = "Dockerfile"
  build-target = "standalone"

[mounts]
  source = "data"
  destination = "/data"

[http_service]
  internal_port = 3001
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

- [ ] **Step 2: Railway config**

Create `railway.json`:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "startCommand": null,
    "restartPolicyType": "ON_FAILURE"
  }
}
```

Note in `docs/deploy-templates.md` that Railway needs two manual dashboard steps: set the Docker build target to `standalone` (service settings → Build) and attach a volume mounted at `/data`.

- [ ] **Step 3: Write the templates doc**

Create `docs/deploy-templates.md` covering, one section each:
- **Fly.io:** the three commands from the `fly.toml` comment; volume required before first deploy; free-allowance caveat (Fly no longer has a true free tier — expect ~$2–5/mo for this size).
- **Railway:** deploy from repo, the two manual steps above, hobby-plan pricing caveat, volume persistence caveat.
- **Coolify:** add resource → Docker Compose or Dockerfile deploy, set build target `standalone`, persistent volume mapped to `/data`, port 3001; Coolify handles HTTPS via its proxy.

Each section ends with: what URL to open, and "your data lives in the volume — snapshot it to back up."

- [ ] **Step 4: Verify fly.toml parses**

```bash
python3 -c "import tomllib; tomllib.load(open('fly.toml','rb')); print('toml ok')"
```

Expected: `toml ok`.

- [ ] **Step 5: Commit**

```bash
git add fly.toml railway.json docs/deploy-templates.md
git commit -m "feat(deploy): Fly.io + Railway templates and Coolify guide for standalone image"
```

---

### Task 8: "Host your music" beginner guide + docs cross-links

**Files:**
- Create: `docs/host-your-music.md`
- Modify: `README.md` (link the guide)
- Modify: `docs/self-hosting.md` (position as the advanced/Postgres+S3 path, link the guide)

**Interfaces:**
- Consumes: quick start (Task 5), templates doc (Task 7).
- Produces: the beginner-facing entry point for the OSS launch.

- [ ] **Step 1: Write the guide**

Create `docs/host-your-music.md`. Required structure and content (write it in plain, non-devops language — the reader is a motivated teenager; define every term the first time it appears, e.g. "a VPS is a small computer you rent that's always on the internet"):

```markdown
# Host Your Music

What you need, what it costs, and three real ways to get your Demo Locker
on the internet.

## What you're setting up
[2–3 sentences: one program, one folder of data; the folder (/data volume)
IS your music library + database — copy it and you've backed everything up.]

## Path 1: Free — an old laptop or Raspberry Pi at home
[Steps: install Docker; the one docker run command from the README;
install cloudflared; `cloudflared tunnel` quick tunnel first, then a named
tunnel + free Cloudflare account for a stable URL/custom domain. Honest
caveats: laptop must stay on; home upload speed limits simultaneous
listeners (give the arithmetic: one 320kbps stream ≈ 0.32 Mbit/s up).]

## Path 2: ~$5/month — a small cloud server (VPS)
[Steps: rent the cheapest Hetzner/DigitalOcean box; ssh in; install
Docker (one command, link Docker's script); the same docker run command;
point a domain at it OR put Cloudflare in front for free HTTPS —
recommend Caddy (`caddy reverse-proxy --from music.example.com
--to localhost:3001`) if they want their own domain without Cloudflare.]

## Path 3: One-click-ish — Fly.io or Railway
[Link docs/deploy-templates.md; honest caveat that these platforms
change free allowances and a card is usually required.]

## How loud can this get?
[Bandwidth honesty section from the spec: fine for demos + a modest band
site; a popular release day will saturate a home line or a $5 VPS; the
fix is a bigger box, a CDN in front, or the hosted Demo Locker (coming).]

## Backing up
[The /data volume is everything. `docker run --rm -v demolocker:/data -v
$(pwd):/backup alpine tar czf /backup/demolocker-backup.tar.gz /data`.
Restore = untar into a fresh volume.]
```

- [ ] **Step 2: Cross-link**

- README: under Self-Host, add first line: `New to hosting? Start with [Host Your Music](docs/host-your-music.md) — the beginner guide.`
- `docs/self-hosting.md`: add an intro note: the compose path documented there is for Postgres + S3 installs; beginners should use the standalone image + guide.

- [ ] **Step 3: Read the guide end-to-end as review**

Check: no unexplained jargon, every command copy-pasteable, costs stated honestly, all three paths end with music playing at a URL.

- [ ] **Step 4: Commit**

```bash
git add docs/host-your-music.md README.md docs/self-hosting.md
git commit -m "docs: beginner 'host your music' guide + cross-links"
```

---

## Self-Review (completed at plan time)

- **Spec coverage:** zero-dep drivers (Tasks 1, 3), one schema/migration set (Task 2), all-in-one image (Task 5), templates (Task 7), guide (Task 8), boot logs + fail-fast (Task 3 code), mixed config valid (drivers select independently, Task 3), PGlite CI testing (Tasks 1/3/6), storage-fs unit tests incl. range + traversal (Task 1), smoke test (Tasks 5/6). ffmpeg/transcode dropped — correction noted in header.
- **Out-of-scope respected:** no schema changes, no public-facing features, no SQLite.
- **Known verify-at-implementation points:** comment/playlist JSON response key shapes in `smoke.sh` (Task 5 Step 2 note); NOT-NULL constraints in the second PGlite test (Task 3 Step 2 note); Railway dashboard steps can't be templated (documented instead).
