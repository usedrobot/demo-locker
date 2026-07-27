# SQLite/D1 Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Postgres (Neon hosted / PGlite self-host) with SQLite everywhere — Cloudflare D1 on Workers, a better-sqlite3 file on Node/Docker — per `docs/superpowers/specs/2026-07-24-sqlite-d1-port-design.md`.

**Architecture:** Clean break. `schema.ts` is rewritten in `sqlite-core` (text UUIDs via app-side `generateId()`, integer epoch-second timestamps surfacing as `Date`, integer booleans). The db layer keeps its factory/cache shape: `db/index.ts` defaults to the D1 driver over a `DB` binding; `db/sqlite.ts` (replacing `db/pglite.ts`) is the Node path. All ~30 route call sites change mechanically from `getDb(c.env.DATABASE_URL)` to `getDb(c.env.DB)`.

**Tech Stack:** drizzle-orm 0.45.2 (`drizzle-orm/d1`, `drizzle-orm/better-sqlite3` — both verified present in the pinned version; there is NO `node:sqlite` adapter in 0.45.2, so better-sqlite3 is the decided driver), drizzle-kit 0.31.10, better-sqlite3 ^12, wrangler ^4.

## Global Constraints

- Monorepo root: `/Users/davidtashjian/webdev/demolocker`. All `packages/api` paths below are relative to root.
- Do NOT bump drizzle-orm / drizzle-kit / wrangler versions. Add only: `better-sqlite3`, `@types/better-sqlite3`.
- `generateId()` MUST return UUID-format strings (spec requirement — migrated Neon IDs are UUIDs and must be indistinguishable from new ones).
- Timestamps use `integer(..., { mode: "timestamp" })` — epoch **seconds** in storage, `Date` objects in JS. The cutover script must convert accordingly.
- No interactive transactions anywhere (D1 doesn't support them; the codebase currently has none — keep it that way).
- Docker base image changes `node:22-alpine` → `node:22-slim`: better-sqlite3 prebuilds are glibc-only; alpine (musl) would force a source compile and drag a toolchain into the image. slim downloads prebuilds on both amd64 and arm64.
- Run all commands from repo root unless the step says otherwise. API test suite: `npm test -w packages/api`. Typecheck: `npm run typecheck -w packages/api`.
- Every commit message follows existing repo style (`feat:`, `chore:`, `docs:` prefixes).
- **Foreground only for all long-running commands (Docker builds, smoke tests) — no background execution; use generous timeouts.**

---

### Task 1: API-side ID generator

**Files:**
- Create: `packages/api/src/lib/ids.ts`
- Test: `packages/api/src/lib/ids.test.ts`

**Interfaces:**
- Produces: `generateId(): string` — UUID-format string. Task 2's schema imports it from `../lib/ids.js`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/lib/ids.test.ts
import { describe, it, expect } from "vitest";
import { generateId } from "./ids.js";

describe("generateId", () => {
  it("returns UUID-format strings", () => {
    expect(generateId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("returns unique values", () => {
    expect(generateId()).not.toBe(generateId());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ids.test.ts` in `packages/api`
Expected: FAIL — cannot find module `./ids.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/api/src/lib/ids.ts
// UUID-format IDs, app-side (SQLite has no uuid default).
// crypto.randomUUID exists on Workers and Node >= 19 — both deploy targets.
export function generateId(): string {
  return crypto.randomUUID();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/ids.test.ts` in `packages/api`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/ids.ts packages/api/src/lib/ids.test.ts
git commit -m "feat(api): add UUID-format generateId for sqlite schema"
```

---

### Task 2: SQLite schema + fresh migration 0000

**Files:**
- Modify: `packages/api/src/db/schema.ts` (full rewrite)
- Modify: `packages/api/drizzle.config.ts`
- Delete: `packages/api/src/db/migrations/*` (all pg migrations + meta)
- Create: regenerated `packages/api/src/db/migrations/` via drizzle-kit

**Interfaces:**
- Consumes: `generateId` from Task 1.
- Produces: same six exported tables (`users`, `sessions`, `playlists`, `tracks`, `comments`, `shares`) with identical property names and JS value types (`string` ids, `Date` timestamps, `boolean` isPublic) — route code compiles unchanged against it.

- [ ] **Step 1: Rewrite the schema in sqlite-core**

Replace the entire contents of `packages/api/src/db/schema.ts` with:

```ts
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { generateId } from "../lib/ids.js";

const now = () => new Date();

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(generateId),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey().$defaultFn(generateId),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});

export const playlists = sqliteTable("playlists", {
  id: text("id").primaryKey().$defaultFn(generateId),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  artworkKey: text("artwork_key"),
  isPublic: integer("is_public", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

export const tracks = sqliteTable("tracks", {
  id: text("id").primaryKey().$defaultFn(generateId),
  // Tracks are library items owned by a user; playlist membership is optional.
  // Deleting a playlist detaches its tracks (SET NULL) instead of deleting them.
  playlistId: text("playlist_id").references(() => playlists.id, {
    onDelete: "set null",
  }),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  position: integer("position").notNull(),
  originalKey: text("original_key").notNull(),
  streamKey: text("stream_key"),
  waveformData: text("waveform_data"),
  duration: real("duration"),
  uploadedAt: integer("uploaded_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

export const comments = sqliteTable("comments", {
  id: text("id").primaryKey().$defaultFn(generateId),
  trackId: text("track_id").references(() => tracks.id, {
    onDelete: "cascade",
  }),
  playlistId: text("playlist_id").references(() => playlists.id, {
    onDelete: "cascade",
  }),
  parentId: text("parent_id"),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  timestampSec: real("timestamp_sec"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  resolvedBy: text("resolved_by").references(() => users.id),
  deleteToken: text("delete_token"),
});

export const shares = sqliteTable("shares", {
  id: text("id").primaryKey().$defaultFn(generateId),
  playlistId: text("playlist_id")
    .notNull()
    .references(() => playlists.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  permission: text("permission", { enum: ["listen", "edit"] }).notNull(),
  email: text("email"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
});
```

- [ ] **Step 2: Point drizzle-kit at sqlite**

Replace the entire contents of `packages/api/drizzle.config.ts` with:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "sqlite",
});
```

- [ ] **Step 3: Delete pg migrations and regenerate**

```bash
rm -rf packages/api/src/db/migrations
cd packages/api && npx drizzle-kit generate --name init
```

Expected: a new `src/db/migrations/0000_init.sql` plus `meta/` journal. Open the .sql and verify it creates all six tables with `text` PKs, `integer` timestamps, and the FK actions (`ON DELETE cascade` / `set null`).

- [ ] **Step 4: Typecheck (schema compiles; consumers still on old db layer will fail — that's expected until Task 4)**

Run: `npx tsc --noEmit -p packages/api 2>&1 | head -30` — errors mentioning `neon`/`pglite`/`DATABASE_URL` are expected and fixed in Tasks 3–4. Errors *inside* `schema.ts` are not; fix those now.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/drizzle.config.ts packages/api/src/db/migrations
git commit -m "feat(api): rewrite schema in sqlite-core, fresh migration 0000"
```

---

### Task 3: DB layer — D1 driver + better-sqlite3 driver

**Files:**
- Modify: `packages/api/src/db/index.ts` (full rewrite)
- Create: `packages/api/src/db/sqlite.ts`
- Delete: `packages/api/src/db/pglite.ts`, `packages/api/src/db/pglite.test.ts`
- Create: `packages/api/src/db/sqlite.test.ts`
- Modify: `packages/api/src/types.ts:9` (`DATABASE_URL: string;` → `DB: unknown;`)
- Modify: `packages/api/package.json` (add better-sqlite3)

**Interfaces:**
- Consumes: Task 2's schema.
- Produces: `getDb(binding: unknown): Database` (D1 default, factory-overridable), `setDbFactory(factory: (binding: unknown) => Database)`, `createSqliteDb(dbPath?: string): Database` (sync; `:memory:` when no path; runs migrations). `Bindings.DB: unknown` replaces `Bindings.DATABASE_URL`.

- [ ] **Step 1: Add the driver dependency**

```bash
npm install -w packages/api better-sqlite3@^12.4.1
npm install -w packages/api -D @types/better-sqlite3
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/api/src/db/sqlite.test.ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createSqliteDb } from "./sqlite.js";
import { users } from "./schema.js";

describe("createSqliteDb", () => {
  it("migrates and round-trips a row with generated id and Date timestamp", async () => {
    const db = createSqliteDb(); // in-memory
    await db.insert(users).values({ email: "sqlite@test.dev", passwordHash: "x" });
    const [found] = await db.select().from(users).where(eq(users.email, "sqlite@test.dev"));
    expect(found.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(found.createdAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/db/sqlite.test.ts` in `packages/api`
Expected: FAIL — cannot find module `./sqlite.js`

- [ ] **Step 4: Implement `db/sqlite.ts`, rewrite `db/index.ts`, delete pglite files**

```ts
// packages/api/src/db/sqlite.ts
// Embedded SQLite (better-sqlite3) for zero-dependency self-hosting.
// Same dialect as D1 — one schema, one migration set.

import { fileURLToPath } from "node:url";
import DatabaseConstructor from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import type { Database } from "./index.js";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

export function createSqliteDb(dbPath?: string): Database {
  const client = new DatabaseConstructor(dbPath ?? ":memory:");
  client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = ON");
  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder });
  return db;
}
```

Replace the entire contents of `packages/api/src/db/index.ts` with:

```ts
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

function createD1Db(binding: unknown): Db {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return drizzle(binding as any, { schema });
}

let _factory: ((binding: unknown) => Db) | null = null;
let _db: Db = null;
let _lastBinding: unknown = null;

// Self-hosted: call this to swap in the sqlite driver
export function setDbFactory(factory: (binding: unknown) => Db) {
  _factory = factory;
  _db = null;
}

export function getDb(binding: unknown): Db {
  if (_db && _lastBinding === binding) return _db;
  _lastBinding = binding;
  _db = _factory ? _factory(binding) : createD1Db(binding);
  return _db;
}

export type Database = Db;
```

Then:

```bash
rm packages/api/src/db/pglite.ts packages/api/src/db/pglite.test.ts
```

In `packages/api/src/types.ts`, change line 9 from `DATABASE_URL: string;` to:

```ts
  DB: unknown; // D1Database on Workers; "sqlite" sentinel on Node (factory ignores it)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/db/sqlite.test.ts` in `packages/api`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A packages/api/src/db packages/api/src/types.ts packages/api/package.json package-lock.json
git commit -m "feat(api): D1 + better-sqlite3 db layer, drop neon/pglite"
```

---

### Task 4: Wire Node entry, route call sites, and test suites

**Files:**
- Modify: `packages/api/src/server.ts:10-42,88` (db section + bindings)
- Modify: every file containing `getDb(c.env.DATABASE_URL)` (`src/lib/session.ts`, `src/lib/playlist-access.ts`, `src/routes/*.ts`)
- Modify: every test file using `createPgliteDb` (`src/routes/public.test.ts`, `src/routes/legacy-access.test.ts`, and any others `grep` finds)

**Interfaces:**
- Consumes: `getDb(binding)`, `setDbFactory`, `createSqliteDb` from Task 3.
- Produces: green API test suite; Node boot uses `DATA_DIR/db/demolocker.db`.

- [ ] **Step 1: Mechanical call-site rename**

```bash
grep -rl 'getDb(c.env.DATABASE_URL)' packages/api/src | xargs perl -pi -e 's/getDb\(c\.env\.DATABASE_URL\)/getDb(c.env.DB)/g'
grep -rn 'DATABASE_URL' packages/api/src --include='*.ts'
```

Expected after the grep: hits only in `server.ts` (fixed next step) and test files (fixed in Step 3).

- [ ] **Step 2: Rewrite server.ts's db section**

In `packages/api/src/server.ts`: delete the imports of `drizzle-orm/postgres-js`, `postgres`, `./db/schema.js`, and `./db/pglite.js`; import `createSqliteDb` from `./db/sqlite.js` instead. Replace the whole `--- database ---` block (the `let databaseUrl ... dbIsZeroDep` section, currently lines 23–42) with:

```ts
  // --- database ---
  // Always embedded sqlite; the file lives in the data volume next to the audio.
  const dbDir = join(dataDir, "db");
  await mkdir(dbDir, { recursive: true }); // fail fast if DATA_DIR unwritable
  const dbPath = join(dbDir, "demolocker.db");
  const sqliteDb = createSqliteDb(dbPath);
  setDbFactory(() => sqliteDb);
  console.log(`db: sqlite (${dbPath})`);
```

Delete the now-unused `dbIsZeroDep` handling: the zero-dep warning block becomes storage-only —

```ts
  if (storageIsZeroDep) {
    console.warn(
      `⚠ storage is local disk — audio lives under ${dataDir}. ` +
        "Set S3_ENDPOINT to use S3.",
    );
  }
```

Also update the file's header comment (lines 1–3) to say: "Zero-dependency mode: embedded SQLite + local-disk storage under DATA_DIR (default ./data); set S3_ENDPOINT to use S3 storage."

In the `bindings` object, replace `DATABASE_URL: databaseUrl,` with:

```ts
    DB: "sqlite", // sentinel — setDbFactory above ignores it and returns the shared db
```

- [ ] **Step 3: Migrate the test suites**

```bash
grep -rln 'createPgliteDb\|DATABASE_URL' packages/api/src --include='*.test.ts'
```

In each hit, apply the same three changes (shown here for `public.test.ts`; repeat identically in the others):

```ts
// before
import { createPgliteDb } from "../db/pglite.js";
...
db = await createPgliteDb();
...
env = { DATABASE_URL: "pglite", DEMOS_BUCKET: bucket };

// after
import { createSqliteDb } from "../db/sqlite.js";
...
db = createSqliteDb();
...
env = { DB: "sqlite", DEMOS_BUCKET: bucket };
```

- [ ] **Step 4: Full suite + typecheck**

Run: `npm test -w packages/api` — Expected: all tests PASS (was 32 + the 2 new suites).
Run: `npm run typecheck -w packages/api` — Expected: clean.
Run: `grep -rn "drizzle-orm/pg-core\|pglite\|neon" packages/api/src --include='*.ts'` — Expected: no hits.

- [ ] **Step 5: Commit**

```bash
git add -A packages/api/src
git commit -m "feat(api): route sqlite everywhere — DB binding, node entry, tests"
```

---

### Task 5: Dependency cleanup + Docker base swap + smoke test

**Files:**
- Modify: `packages/api/package.json` (remove `@electric-sql/pglite`, `@neondatabase/serverless`, `postgres`)
- Modify: `Dockerfile` (base `node:22-alpine` → `node:22-slim`; nginx stage unchanged)

**Interfaces:**
- Consumes: green suite from Task 4.
- Produces: a bootable standalone Docker image on sqlite; `scripts/smoke.sh` green.

- [ ] **Step 1: Remove dead dependencies**

```bash
npm uninstall -w packages/api @electric-sql/pglite @neondatabase/serverless postgres
npm test -w packages/api && npm run typecheck -w packages/api
```

Expected: both green.

- [ ] **Step 2: Swap the Docker base**

In `Dockerfile`, change line 2 `FROM node:22-alpine AS base` to:

```dockerfile
FROM node:22-slim AS base
```

Reason (add as a comment above the line): better-sqlite3 ships glibc prebuilds only; alpine/musl would compile from source and need a toolchain in the image.

Check the rest of the Dockerfile for alpine-isms (`apk` commands, `adduser -D` flags); the `nginx:alpine` web stage stays as-is.

- [ ] **Step 3: Build and smoke (FOREGROUND, generous timeout — this takes minutes)**

Run: `./scripts/smoke.sh`
Expected: exits 0 — boot log shows `db: sqlite (/data/db/demolocker.db)` (or the script's DATA_DIR), upload/playback steps pass.

If smoke.sh greps for a `pglite` boot-log line, update the assertion to the new `db: sqlite` line as part of this step.

- [ ] **Step 4: Commit**

```bash
git add packages/api/package.json package-lock.json Dockerfile scripts/smoke.sh
git commit -m "chore: drop postgres deps, node:22-slim base for better-sqlite3 prebuilds"
```

---

### Task 6: Worker wiring — D1 binding + CI migrations

**Files:**
- Modify: `packages/api/wrangler.jsonc` (add `d1_databases`)
- Modify: `.github/workflows/ci.yml` (deploy-api job: apply migrations before deploy)

**Interfaces:**
- Consumes: migration files from Task 2.
- Produces: Worker builds with a `DB` binding; CI applies D1 migrations on every main deploy.

**NOTE — needs DL's Cloudflare auth once:** creating the database is a one-time manual step. If not already done, STOP and ask DL to run it rather than guessing.

- [ ] **Step 1: Create the D1 database (one-time, DL-authed)**

```bash
cd packages/api && npx wrangler d1 create demo-locker-db
```

Expected output includes a `database_id` — copy it for Step 2.

- [ ] **Step 2: Add the binding**

In `packages/api/wrangler.jsonc`, after the `r2_buckets` array, add:

```jsonc
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "demo-locker-db",
      "database_id": "<id from step 1>",
      "migrations_dir": "src/db/migrations"
    }
  ],
```

Also delete the stale trailing comment about `DATABASE_URL` being a secret.

- [ ] **Step 3: Verify the Worker types/builds locally**

Run in `packages/api`: `npx wrangler deploy --dry-run --outdir /tmp/wrangler-dry`
Expected: bundles cleanly, no missing-module errors (neon is gone).

- [ ] **Step 4: CI applies migrations before deploy**

In `.github/workflows/ci.yml`, inside the `deploy-api` job, insert *before* the `npx wrangler deploy` step:

```yaml
      - run: npx wrangler d1 migrations apply demo-locker-db --remote
        working-directory: packages/api
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

(The API token needs D1 edit permission — verify in the Cloudflare dashboard with DL; the current token was scoped for Workers+Pages only.)

- [ ] **Step 5: Commit**

```bash
git add packages/api/wrangler.jsonc .github/workflows/ci.yml
git commit -m "feat(deploy): D1 binding + CI-applied migrations"
```

---

### Task 7: Docs

**Files:**
- Modify: `docs/self-hosting.md` (remove Postgres/`DATABASE_URL`/PGlite/MinIO-as-default references; document the sqlite file at `DATA_DIR/db/demolocker.db`; backup = copy the data dir)
- Modify: `README.md` (stack table: DB row → "SQLite — D1 hosted, embedded file self-host")
- Modify: `AGENTS.md` (runbook: any `DATABASE_URL` env references; boot-log lines now `db: sqlite (...)`)
- Modify: `llms.txt` (same sweep)
- Modify: `docker-compose.yml` (drop any postgres/`DATABASE_URL` service/env if present)

- [ ] **Step 1: Sweep and edit**

```bash
grep -rn "DATABASE_URL\|[Pp]ostgres\|PGlite\|pglite\|Neon" README.md AGENTS.md llms.txt docs/self-hosting.md docker-compose.yml
```

Fix every hit per the file list above. Where `self-hosting.md` documented "set DATABASE_URL to use Postgres," the replacement copy is: "The database is an embedded SQLite file at `DATA_DIR/db/demolocker.db` — backing up your locker means copying the data directory."

- [ ] **Step 2: Re-run the grep to verify zero stale hits, then commit**

```bash
git add README.md AGENTS.md llms.txt docs/self-hosting.md docker-compose.yml
git commit -m "docs: sqlite everywhere — no more Postgres/DATABASE_URL"
```

---

### Task 8: Neon → D1 cutover script + runbook (GATED — execute only at merge time, DL present)

**Files:**
- Create: `scripts/neon-to-d1.mjs`
- Create: `docs/superpowers/plans/2026-07-24-cutover-runbook.md`

**Interfaces:**
- Consumes: D1 database from Task 6; frozen Neon data via `packages/api/.dev.vars` (`DATABASE_URL=...`, gitignored — DL recreates it from the Neon dashboard if absent).
- Produces: a D1-ready INSERT dump + verified row counts.

> **Stale copy warning.** The script and runbook text embedded below are the
> *original* drafts. Both have since been revised (UTC date-parser override,
> `INSERT OR REPLACE`, epoch-**milliseconds**, dump written outside the repo,
> `--local` rehearsal, value spot-checks, reset-and-rerun recovery). Follow
> `scripts/neon-to-d1.mjs` and
> `docs/superpowers/plans/2026-07-24-cutover-runbook.md` — not this section.

- [ ] **Step 1: Write the export script**

```js
// scripts/neon-to-d1.mjs
// One-time Neon -> D1 export. Usage:
//   npm i --no-save postgres
//   node scripts/neon-to-d1.mjs > dump.sql
// Reads DATABASE_URL from packages/api/.dev.vars. Row counts go to stderr.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const vars = readFileSync("packages/api/.dev.vars", "utf-8");
const url = vars.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
if (!url) {
  console.error("DATABASE_URL not found in packages/api/.dev.vars");
  process.exit(1);
}
const sql = postgres(url);

// FK dependency order — parents first.
const TABLES = ["users", "sessions", "playlists", "tracks", "comments", "shares"];

function lit(v) {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return String(Math.floor(v.getTime() / 1000)); // epoch seconds
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  return `'${String(v).replaceAll("'", "''")}'`;
}

for (const table of TABLES) {
  const rows = await sql`select * from ${sql(table)}`;
  console.error(`${table}: ${rows.length} rows`);
  for (const row of rows) {
    const cols = Object.keys(row);
    console.log(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols
        .map((c) => lit(row[c]))
        .join(", ")});`,
    );
  }
}
await sql.end();
```

(`postgres` returns snake_case column names as-is, matching the SQLite DDL exactly, and hydrates `timestamp` columns as `Date` — so `lit()` covers every column type in the schema.)

- [ ] **Step 2: Write the runbook**

Create `docs/superpowers/plans/2026-07-24-cutover-runbook.md`:

```markdown
# Hosted cutover: Neon -> D1 (DL present, ~minutes of downtime)

Preconditions: port branch reviewed and ready to merge; Tasks 1-7 green in CI on the branch; D1 db exists with binding in wrangler.jsonc; `packages/api/.dev.vars` holds the Neon DATABASE_URL.

1. Announce freeze (nobody uploads/comments during the window).
2. `cd packages/api && npx wrangler d1 migrations apply demo-locker-db --remote`
3. From repo root: `npm i --no-save postgres && node scripts/neon-to-d1.mjs > dump.sql`
   - stderr shows per-table Neon counts. Record them.
4. `cd packages/api && npx wrangler d1 execute demo-locker-db --remote --file ../../dump.sql`
5. Verify counts, each table:
   `npx wrangler d1 execute demo-locker-db --remote --json --command "select count(*) as n from users"`
   (repeat for sessions, playlists, tracks, comments, shares — must match step 3.)
6. Merge the PR -> CI deploys the D1-backed Worker + web.
7. Live verification: login, playback, waveform comments, listen + edit share links, /embed.js player on a public playlist.
8. Delete `dump.sql` (contains password hashes + session tokens — do not commit it; it is not gitignored).
9. Rollback window: leave Neon untouched for 7 days. Rollback = `git revert` the merge and redeploy (old Worker still speaks Neon). After 7 days with no issues: delete the Neon project and the DATABASE_URL Worker secret (`npx wrangler secret delete DATABASE_URL`), and delete `.dev.vars`.
```

- [ ] **Step 3: Commit (script + runbook only — never dump.sql)**

```bash
git add scripts/neon-to-d1.mjs docs/superpowers/plans/2026-07-24-cutover-runbook.md
git commit -m "feat(scripts): neon-to-d1 export + cutover runbook"
```

---

## Post-merge follow-ups (not tasks in this plan)

- Execute the cutover runbook with DL (Task 8's artifact).
- Update vault notes + regenerate CLAUDE.md: retire the "ALTER prod Neon before merging" rule and the Neon `.dev.vars` procedure notes (per `vault/feedback/regenerate-claude-md.md`).
- Spec 2 brainstorm: wizard `cloudflare` target, drop Fly/Railway, Docker expose step; DL rebuilds his instance through it as the live test.
