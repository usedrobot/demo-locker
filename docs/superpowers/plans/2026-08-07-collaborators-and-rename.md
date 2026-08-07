# Collaborators + Playlist Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a locker owner invite collaborators who share the owner's library — uploading tracks, creating playlists, and renaming them — while only ever being able to delete what they themselves put there. Plus the missing rename affordance.

**Architecture:** Collaboration is a *membership* relation, not a new ownership model. `users.locker_owner_id` marks an account as belonging to someone else's locker; a resolver turns any session into "which locker am I acting in"; and the 14 existing `row.ownerId === userId` checks become membership checks. Tracks and playlists keep a single `ownerId` pointing at the locker owner, so no existing row is re-parented and no join table appears. Two new nullable columns (`tracks.uploaded_by`, `playlists.created_by`) record who actually did the thing, which is what makes both attribution and the delete rule possible.

**Tech Stack:** Hono, Drizzle ORM, SQLite/D1, vitest (API); React + Vite, vanilla CSS (web).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-07-collaborators-rename-cli-design.md`. Read it before Task 1.
- **Migrations are generated, never hand-written:** `npx drizzle-kit generate` from `packages/api` (config `drizzle.config.ts`, dialect sqlite, out `./src/db/migrations`). The next migration is `0003_*`; `0000`–`0002` exist.
- **Additive columns only.** Every new column is nullable with no default backfill. Drizzle selects every column explicitly, so code deployed ahead of its migration breaks all reads of that table.
- **Non-enumerable 404s.** A denied request returns `{ error: "not found" }` with 404 — never 401/403 — matching `lib/playlist-access.ts`'s existing contract. The one exception is `requireAuth` itself, which 401s on a missing/invalid session.
- **Tests insert sessions with raw tokens** (e.g. `db.insert(sessions).values({ userId, token: "sess-x", expiresAt: future })`). `findSession` matches those on its legacy fallback path. Follow the existing convention in `routes/legacy-access.test.ts`.
- **Run the ROOT typecheck before every commit:** `npm run typecheck` from the repo root. CI is stricter than the workspace scripts, and `vitest` does not typecheck — a green suite says nothing about whether the tree compiles.
- **Do not touch `site/`.** Brochure copy is out of scope until after launch (DL, 2026-08-07).
- **New API routes must be added to `docs/openapi.json`** (the shipped contract, 29 paths today) in the same task that creates them.

---

## File Structure

**Created:**
- `packages/api/src/lib/locker.ts` — the membership resolver. One function, no I/O.
- `packages/api/src/routes/collab.ts` — invite + member management router.
- `packages/api/src/routes/collab.test.ts` — invite mint/redeem/revoke suite.
- `packages/api/src/routes/membership.test.ts` — the collaborator-can / collaborator-cannot matrix over all 14 sites.
- `packages/api/src/db/migrations/0003_*.sql` — generated.
- `packages/web/src/components/CollabPanel.tsx` — invite + member list, Home only.
- `packages/web/src/pages/Join.tsx` — invite redemption (set email + password).

**Modified:**
- `packages/api/src/db/schema.ts` — 3 columns + `collaboratorInvites` table.
- `packages/api/src/types.ts` — `User` gains `lockerOwnerId`.
- `packages/api/src/lib/session.ts:84-88` — `requireAuth` selects the new column.
- `packages/api/src/routes/playlists.ts` — 5 checks, `createdBy` on create, delete guard.
- `packages/api/src/routes/tracks.ts` — 4 checks, `uploadedBy` on upload, delete guard.
- `packages/api/src/routes/shares.ts` — 5 checks.
- `packages/api/src/routes/auth.ts:25-67` — signup accepts an invite token.
- `packages/api/src/index.ts` — mount `/collab`.
- `packages/web/src/lib/api.ts` — `collab` client, `Share.label`, `User.lockerOwnerId`.
- `packages/web/src/components/SharePanel.tsx:26` — mint edit links, with a label.
- `packages/web/src/pages/PlaylistView.tsx:115` — rename control.
- `packages/web/src/pages/Home.tsx` — mount `CollabPanel`.
- `packages/web/src/App.tsx` — `/join/:token` route.
- `docs/openapi.json`, `AGENTS.md`.

---

## Where the collaborator boundary sits (DL, 2026-08-07)

The spec was silent on two capabilities. DL's ruling:

- **Collaborators MAY mint share links.** Sharing a playlist with a listener is band work, not administration — the same kind of act as adding a track. Task 5 therefore scopes the share routes to the locker like everything else, with no owner-only guard.
- **Collaborators MAY NOT publish a playlist** (`isPublic`). Publishing puts a playlist on the open web through `/public/v1` and the embed, permanently and for anyone. That stays the owner's call. Enforced in Task 3.

Everything else — create, upload, reorder, attach, rename — is collaborator-allowed. Inviting further collaborators stays owner-only (Task 7).

---

### Task 1: Schema columns, invite table, and the migration

**Files:**
- Modify: `packages/api/src/db/schema.ts`
- Create: `packages/api/src/db/migrations/0003_*.sql` (generated)
- Test: `packages/api/src/db/sqlite.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `users.lockerOwnerId`, `tracks.uploadedBy`, `playlists.createdBy`, and the `collaboratorInvites` table. Column names in SQL are `locker_owner_id`, `uploaded_by`, `created_by`.

**Why `onDelete: "set null"` on the two attribution columns matters:** revoking a collaborator deletes their user row. `foreign_keys = ON` is set in `db/sqlite.ts`, so a `uploaded_by` still pointing at that row would abort the delete. SET NULL means their tracks survive the revoke and read as the owner's, which is the correct outcome — the files belong to the locker, not the person.

- [ ] **Step 1: Write the failing test**

Append to `packages/api/src/db/sqlite.test.ts`:

```ts
import { collaboratorInvites } from "./schema.js";

describe("collaboration schema", () => {
  it("stores a collaborator bound to an owner's locker", async () => {
    const db = createSqliteDb();
    const [owner] = await db
      .insert(users)
      .values({ email: "owner@test.dev", passwordHash: "x" })
      .returning();
    const [collab] = await db
      .insert(users)
      .values({
        email: "collab@test.dev",
        passwordHash: "x",
        lockerOwnerId: owner.id,
      })
      .returning();

    expect(collab.lockerOwnerId).toBe(owner.id);
    expect(owner.lockerOwnerId).toBeNull();
  });

  it("nulls attribution instead of blocking the delete when a collaborator is removed", async () => {
    const db = createSqliteDb();
    const [owner] = await db
      .insert(users)
      .values({ email: "o2@test.dev", passwordHash: "x" })
      .returning();
    const [collab] = await db
      .insert(users)
      .values({ email: "c2@test.dev", passwordHash: "x", lockerOwnerId: owner.id })
      .returning();
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId: owner.id, name: "demos", createdBy: collab.id })
      .returning();
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId: owner.id,
        playlistId: pl.id,
        title: "riff",
        position: 0,
        originalKey: "k",
        uploadedBy: collab.id,
      })
      .returning();

    await db.delete(users).where(eq(users.id, collab.id));

    const [track] = await db.select().from(tracks).where(eq(tracks.id, tr.id));
    const [playlist] = await db.select().from(playlists).where(eq(playlists.id, pl.id));
    expect(track.uploadedBy).toBeNull();
    expect(track.ownerId).toBe(owner.id);
    expect(playlist.createdBy).toBeNull();
  });

  it("stores an unredeemed collaborator invite", async () => {
    const db = createSqliteDb();
    const [owner] = await db
      .insert(users)
      .values({ email: "o3@test.dev", passwordHash: "x" })
      .returning();
    const [invite] = await db
      .insert(collaboratorInvites)
      .values({ ownerId: owner.id, token: "inv-token", label: "Jimmy" })
      .returning();

    expect(invite.label).toBe("Jimmy");
    expect(invite.acceptedBy).toBeNull();
  });
});
```

Add `eq` from `drizzle-orm` and `users`, `playlists`, `tracks` to the file's imports if not already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w packages/api -- sqlite.test.ts`
Expected: FAIL — `collaboratorInvites` is not exported, and `lockerOwnerId` / `uploadedBy` / `createdBy` are not properties.

- [ ] **Step 3: Add the columns and table**

In `packages/api/src/db/schema.ts`, add to `users`:

```ts
  // Null = this account owns a locker. Set = this account is a collaborator on
  // the referenced owner's locker, sharing that library rather than having one
  // of its own. Self-referential, so it is declared with an explicit callback.
  lockerOwnerId: text("locker_owner_id").references((): any => users.id, {
    onDelete: "cascade",
  }),
```

Add to `playlists`:

```ts
  // Who created this playlist. Null on rows predating collaboration, and on
  // rows whose creator has since been removed — both read as the owner.
  createdBy: text("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
```

Add to `tracks`:

```ts
  // Who uploaded this file. `ownerId` says which locker it belongs to; this
  // says whose demo it is. SET NULL rather than cascade: removing a person
  // must never remove their music from the owner's library.
  uploadedBy: text("uploaded_by").references(() => users.id, {
    onDelete: "set null",
  }),
```

Add a new table at the end of the file:

```ts
// A one-shot invitation to join someone's locker as a collaborator. Signup is
// closed on every instance once an owner exists (lib/signup.ts); a valid,
// unredeemed invite is the only thing that opens it, and only for one account.
export const collaboratorInvites = sqliteTable("collaborator_invites", {
  id: text("id").primaryKey().$defaultFn(generateId),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  // Shown in the owner's access list so a pending invite is identifiable
  // before it is redeemed. Not an email — nothing is sent.
  label: text("label").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  acceptedBy: text("accepted_by").references(() => users.id, {
    onDelete: "set null",
  }),
  acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
});
```

- [ ] **Step 4: Generate the migration**

Run: `cd packages/api && npx drizzle-kit generate`
Expected: a new `src/db/migrations/0003_<name>.sql` plus an updated `meta/_journal.json` with `"idx": 3`.

Open the generated SQL and confirm it is four `ALTER TABLE ... ADD COLUMN` statements plus one `CREATE TABLE collaborator_invites`. **If it contains any `DROP` or table-rebuild statement, stop and report it** — that is not an additive migration and must not ship.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w packages/api -- sqlite.test.ts`
Expected: PASS. `createSqliteDb()` runs migrations on an in-memory DB, so this exercises the generated SQL, not just the schema objects.

- [ ] **Step 6: Root typecheck**

Run: `npm run typecheck` from the repo root.
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/src/db/migrations packages/api/src/db/sqlite.test.ts
git commit -m "feat(db): collaborator membership, upload attribution, invite table"
```

---

### Task 2: The membership resolver

**Files:**
- Create: `packages/api/src/lib/locker.ts`
- Modify: `packages/api/src/types.ts`, `packages/api/src/lib/session.ts`
- Test: `packages/api/src/lib/locker.test.ts`

**Interfaces:**
- Consumes: `users.lockerOwnerId` (Task 1).
- Produces:
  - `type User = { id: string; email: string; accent: string | null; lockerOwnerId: string | null }`
  - `lockerIdOf(user: User): string` — the owner id of the locker this user acts in.
  - `isLockerOwner(user: User): boolean` — true when the user owns their locker.

Every later task uses `lockerIdOf`. It is deliberately pure and synchronous: `requireAuth` already loads the user row, so no route needs a second query to answer "which locker."

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/lib/locker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { lockerIdOf, isLockerOwner } from "./locker.js";
import type { User } from "../types.js";

const owner: User = { id: "u-owner", email: "o@t.dev", accent: null, lockerOwnerId: null };
const collab: User = { id: "u-collab", email: "c@t.dev", accent: null, lockerOwnerId: "u-owner" };

describe("lockerIdOf", () => {
  it("returns an owner's own id", () => {
    expect(lockerIdOf(owner)).toBe("u-owner");
  });

  it("returns the owner's id for a collaborator", () => {
    expect(lockerIdOf(collab)).toBe("u-owner");
  });
});

describe("isLockerOwner", () => {
  it("is true for an owner", () => {
    expect(isLockerOwner(owner)).toBe(true);
  });

  it("is false for a collaborator", () => {
    expect(isLockerOwner(collab)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w packages/api -- locker.test.ts`
Expected: FAIL — cannot resolve `./locker.js`.

- [ ] **Step 3: Write the resolver**

Create `packages/api/src/lib/locker.ts`:

```ts
// Which locker is this session acting in?
//
// A Demo Locker belongs to exactly one owner. Collaborators are users whose
// `lockerOwnerId` points at that owner: they share the library rather than
// having one of their own, so every `ownerId` column on tracks and playlists
// keeps pointing at the owner no matter who created the row.
//
// This is what the ownership checks across playlists/tracks/shares compare
// against. It is pure and synchronous on purpose — requireAuth has already
// loaded the user, so asking "which locker" must never cost another query.

import type { User } from "../types.js";

export function lockerIdOf(user: User): string {
  return user.lockerOwnerId ?? user.id;
}

// True only for the account that owns the locker. Gates the things that are
// locker-level rather than library-level: inviting collaborators, publishing a
// playlist, and minting share links.
export function isLockerOwner(user: User): boolean {
  return user.lockerOwnerId === null;
}
```

- [ ] **Step 4: Add `lockerOwnerId` to the User type**

In `packages/api/src/types.ts`:

```ts
export type User = {
  id: string;
  email: string;
  accent: string | null;
  // Null = owns this locker. Set = collaborator on that owner's locker.
  lockerOwnerId: string | null;
};
```

- [ ] **Step 5: Select the column in requireAuth**

In `packages/api/src/lib/session.ts`, the `requireAuth` middleware's user query becomes:

```ts
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      accent: users.accent,
      lockerOwnerId: users.lockerOwnerId,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w packages/api`
Expected: PASS, whole suite. If `routes/auth.ts`'s `.returning({...})` now mismatches `User`, extend it there too — signup and login both return a user object that must carry the new field.

- [ ] **Step 7: Root typecheck**

Run: `npm run typecheck` from the repo root.
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/lib/locker.ts packages/api/src/lib/locker.test.ts packages/api/src/types.ts packages/api/src/lib/session.ts packages/api/src/routes/auth.ts
git commit -m "feat(api): lockerIdOf resolver and lockerOwnerId on the session user"
```

---

### Task 3: Widen the playlist routes to locker membership

**Files:**
- Modify: `packages/api/src/routes/playlists.ts` (lines 27, 45, 101, 136, 215)
- Test: `packages/api/src/routes/membership.test.ts` (created here)

**Interfaces:**
- Consumes: `lockerIdOf`, `isLockerOwner` (Task 2); `playlists.createdBy` (Task 1).
- Produces: the shared `membership.test.ts` fixture — an owner, a collaborator on that locker, and a stranger — reused by Tasks 4, 5 and 6.

The five sites, and what each becomes:

| Line | Today | Becomes |
|---|---|---|
| 27 | `GET /` lists `where(ownerId, userId)` | `where(ownerId, lockerId)` — collaborator sees the same library |
| 45 | `POST /` counts playlists for the limit | counts against `lockerId` |
| 101 | `PATCH /:id` owner check | `playlist.ownerId === lockerId`, **plus** `isPublic` requires `isLockerOwner(user)` |
| 136 | `POST /:id/artwork` owner check | `playlist.ownerId === lockerId` |
| 215 | `DELETE /:id` owner check | Task 6 |

`POST /` also sets `createdBy: user.id`.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/routes/membership.test.ts`:

```ts
// A collaborator shares the owner's library: same playlists, same tracks, and
// the ability to add to both. What they may NOT do is act on the locker itself
// (publish, share, invite) or destroy something they did not create.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";
import { createFsBucket } from "../lib/storage-fs.js";
import { users, playlists, sessions } from "../db/schema.js";

let db: Database;
let root: string;
let env: Record<string, unknown>;

let ownerId: string;
let collabId: string;
let ownerToken: string;
let collabToken: string;
let strangerToken: string;
let ownerPlaylistId: string;

beforeAll(async () => {
  db = createSqliteDb();
  setDbFactory(() => db);
  root = await mkdtemp(join(tmpdir(), "dl-member-"));
  env = { DB: "sqlite", DEMOS_BUCKET: createFsBucket(root) };

  const [owner] = await db
    .insert(users)
    .values({ email: "member-owner@test.dev", passwordHash: "x" })
    .returning();
  ownerId = owner.id;
  const [collab] = await db
    .insert(users)
    .values({
      email: "member-collab@test.dev",
      passwordHash: "x",
      lockerOwnerId: owner.id,
    })
    .returning();
  collabId = collab.id;
  const [stranger] = await db
    .insert(users)
    .values({ email: "member-stranger@test.dev", passwordHash: "x" })
    .returning();

  const future = new Date(Date.now() + 1000 * 60 * 60);
  ownerToken = "member-owner-token";
  collabToken = "member-collab-token";
  strangerToken = "member-stranger-token";
  await db.insert(sessions).values({ userId: owner.id, token: ownerToken, expiresAt: future });
  await db.insert(sessions).values({ userId: collab.id, token: collabToken, expiresAt: future });
  await db.insert(sessions).values({ userId: stranger.id, token: strangerToken, expiresAt: future });

  const [pl] = await db
    .insert(playlists)
    .values({ ownerId: owner.id, name: "owner demos" })
    .returning();
  ownerPlaylistId = pl.id;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("playlists under collaboration", () => {
  it("lists the owner's playlists for a collaborator", async () => {
    const res = await app.request("/playlists", { headers: auth(collabToken) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { playlists: { id: string }[] };
    expect(body.playlists.map((p) => p.id)).toContain(ownerPlaylistId);
  });

  it("does not list them for a stranger", async () => {
    const res = await app.request("/playlists", { headers: auth(strangerToken) }, env);
    const body = (await res.json()) as { playlists: unknown[] };
    expect(body.playlists).toHaveLength(0);
  });

  it("creates a playlist into the owner's locker, attributed to the collaborator", async () => {
    const res = await app.request(
      "/playlists",
      {
        method: "POST",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "collab demos" }),
      },
      env
    );
    expect(res.status).toBe(201);
    const { playlist } = (await res.json()) as {
      playlist: { id: string; ownerId: string; createdBy: string };
    };
    expect(playlist.ownerId).toBe(ownerId);
    expect(playlist.createdBy).toBe(collabId);
  });

  it("lets a collaborator rename the owner's playlist", async () => {
    const res = await app.request(
      `/playlists/${ownerPlaylistId}`,
      {
        method: "PATCH",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "renamed by collab" }),
      },
      env
    );
    expect(res.status).toBe(200);
    const { playlist } = (await res.json()) as { playlist: { name: string } };
    expect(playlist.name).toBe("renamed by collab");
  });

  it("refuses to let a collaborator publish a playlist", async () => {
    const res = await app.request(
      `/playlists/${ownerPlaylistId}`,
      {
        method: "PATCH",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ isPublic: true }),
      },
      env
    );
    expect(res.status).toBe(404);
    const [row] = await db.select().from(playlists).where(eq(playlists.id, ownerPlaylistId));
    expect(row.isPublic).toBe(false);
  });

  it("404s a stranger patching the playlist", async () => {
    const res = await app.request(
      `/playlists/${ownerPlaylistId}`,
      {
        method: "PATCH",
        headers: { ...auth(strangerToken), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "hijacked" }),
      },
      env
    );
    expect(res.status).toBe(404);
  });
});
```

Add `import { eq } from "drizzle-orm";` at the top.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w packages/api -- membership.test.ts`
Expected: FAIL — the collaborator sees an empty list and gets 404 on create/rename.

- [ ] **Step 3: Widen the five sites**

In `packages/api/src/routes/playlists.ts`, import the resolver:

```ts
import { lockerIdOf, isLockerOwner } from "../lib/locker.js";
```

`GET /` (line ~27) — replace `const userId = c.get("user").id;` usage in the where clause:

```ts
  const lockerId = lockerIdOf(c.get("user"));
  const rows = await db
    .select()
    .from(playlists)
    .where(eq(playlists.ownerId, lockerId))
```

`POST /` (line ~45) — the limit count and the insert:

```ts
  const user = c.get("user");
  const lockerId = lockerIdOf(user);
  // ... limit check counts against the locker, not the acting user
      .where(eq(playlists.ownerId, lockerId));
  // ... and the insert records who actually made it
  const [playlist] = await db
    .insert(playlists)
    .values({ ownerId: lockerId, name, createdBy: user.id })
    .returning();
```

`PATCH /:id` (line ~101):

```ts
  const user = c.get("user");
  const lockerId = lockerIdOf(user);
  // ...
  if (!playlist || playlist.ownerId !== lockerId) {
    return c.json({ error: "not found" }, 404);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name) updates.name = body.name;
  // Publishing is a locker-level decision, not library work: it puts the
  // playlist on the open web via /public/v1. Collaborators may organise the
  // library; only the owner may publish from it.
  if (typeof body.isPublic === "boolean") {
    if (!isLockerOwner(user)) return c.json({ error: "not found" }, 404);
    updates.isPublic = body.isPublic;
  }
```

`POST /:id/artwork` (line ~136):

```ts
  const lockerId = lockerIdOf(c.get("user"));
  // ...
  if (!playlist || playlist.ownerId !== lockerId) {
```

Leave `DELETE /:id` (line ~215) alone — Task 6 owns it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/api`
Expected: PASS, including the pre-existing `legacy-access.test.ts` (the stranger cases there must not regress).

- [ ] **Step 5: Root typecheck**

Run: `npm run typecheck` from the repo root.
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/playlists.ts packages/api/src/routes/membership.test.ts
git commit -m "feat(api): playlists are locker-scoped, not owner-scoped"
```

---

### Task 4: Widen the track routes and record who uploaded

**Files:**
- Modify: `packages/api/src/routes/tracks.ts` (lines 86, 140, 259, 270)
- Test: `packages/api/src/routes/membership.test.ts` (extend)

**Interfaces:**
- Consumes: `lockerIdOf` (Task 2), `tracks.uploadedBy` (Task 1), the fixture from Task 3.
- Produces: uploads carry `uploadedBy`, which Task 6's delete guard reads.

| Line | Today | Becomes |
|---|---|---|
| 86 | storage accounting `where(tracks.ownerId, ownerId)` | already the locker owner via `requestCanEditPlaylist` — confirm, no change expected |
| 140 | `GET /` library list, `where(ownerId, user.id)` | `where(ownerId, lockerId)` |
| 259 | `PATCH /:id` track owner check | `track.ownerId === lockerId` |
| 270 | `PATCH /:id` target playlist check | `playlist.ownerId === lockerId` |

`POST /upload` sets `uploadedBy`. Note the two paths differ: the playlist path resolves `ownerId` through `requestCanEditPlaylist` (which may be an anonymous edit-share holder with no session), the library path through `requestSessionUserId`. **`uploadedBy` is the session user when there is one, and null when the uploader is an anonymous share-token holder** — a share holder is not a user and has no id to record.

- [ ] **Step 1: Write the failing test**

Append to `packages/api/src/routes/membership.test.ts`:

```ts
describe("tracks under collaboration", () => {
  it("shows the owner's library to a collaborator", async () => {
    await db.insert(tracks).values({
      ownerId,
      title: "owner riff",
      position: 0,
      originalKey: "lib/owner-riff",
      uploadedBy: ownerId,
    });

    const res = await app.request("/tracks", { headers: auth(collabToken) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tracks: { title: string }[] };
    expect(body.tracks.map((t) => t.title)).toContain("owner riff");
  });

  it("hides it from a stranger", async () => {
    const res = await app.request("/tracks", { headers: auth(strangerToken) }, env);
    const body = (await res.json()) as { tracks: unknown[] };
    expect(body.tracks).toHaveLength(0);
  });

  it("lets a collaborator move an owner's track between playlists", async () => {
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "movable",
        position: 0,
        originalKey: "lib/movable",
        uploadedBy: ownerId,
      })
      .returning();

    const res = await app.request(
      `/tracks/${tr.id}`,
      {
        method: "PATCH",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ playlistId: ownerPlaylistId }),
      },
      env
    );
    expect(res.status).toBe(200);
  });

  it("404s a stranger moving the same track", async () => {
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "not yours",
        position: 0,
        originalKey: "lib/not-yours",
        uploadedBy: ownerId,
      })
      .returning();

    const res = await app.request(
      `/tracks/${tr.id}`,
      {
        method: "PATCH",
        headers: { ...auth(strangerToken), "Content-Type": "application/json" },
        body: JSON.stringify({ playlistId: null }),
      },
      env
    );
    expect(res.status).toBe(404);
  });

  it("attributes a collaborator's upload to them, in the owner's locker", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "demo.wav"), "demo.wav");
    form.append("title", "collab upload");

    const res = await app.request(
      "/tracks/upload",
      { method: "POST", headers: auth(collabToken), body: form },
      env
    );
    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(tracks)
      .where(eq(tracks.title, "collab upload"));
    expect(row.ownerId).toBe(ownerId);
    expect(row.uploadedBy).toBe(collabId);
  });
});
```

Add `tracks` to the schema import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w packages/api -- membership.test.ts`
Expected: FAIL — library list is empty for the collaborator, PATCH 404s, and `uploadedBy` is undefined.

- [ ] **Step 3: Widen the routes**

In `packages/api/src/routes/tracks.ts`, import `lockerIdOf` from `../lib/locker.js`.

`GET /` (line ~140):

```ts
    .where(eq(tracks.ownerId, lockerIdOf(c.get("user"))))
```

`PATCH /:id` (lines ~259 and ~270):

```ts
  const lockerId = lockerIdOf(c.get("user"));
  // ...
  if (!track || track.ownerId !== lockerId) {
    return c.json({ error: "not found" }, 404);
  }
  // ... and the destination playlist
    if (!playlist || playlist.ownerId !== lockerId) {
```

`POST /upload` — record the uploader. After `ownerId` is resolved, before the insert:

```ts
  // Who actually uploaded this. Null when the uploader is an anonymous edit-
  // share holder: they are not a user and have no id to record. `ownerId`
  // still points at the locker owner in every case.
  const uploadedBy = await requestSessionUserId(c);
```

and add `uploadedBy` to the `.values({...})` of the track insert.

Line ~86's storage accounting already counts against the resolved `ownerId`, which is the locker owner on both paths — read it and confirm, change nothing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/api`
Expected: PASS. `upload-rendition.test.ts` and `download.test.ts` must still pass unchanged.

- [ ] **Step 5: Root typecheck**

Run: `npm run typecheck` from the repo root.
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/tracks.ts packages/api/src/routes/membership.test.ts
git commit -m "feat(api): tracks are locker-scoped, uploads record their uploader"
```

---

### Task 5: Share routes are locker-scoped — collaborators may share

**Files:**
- Modify: `packages/api/src/routes/shares.ts` (lines 31, 83, 110, 134, 165)
- Test: `packages/api/src/routes/membership.test.ts` (extend)

**Interfaces:**
- Consumes: `lockerIdOf` (Task 2).
- Produces: nothing new for later tasks.

Per DL's ruling, sharing a playlist with a listener is band work. All five sites become locker-scoped exactly like the playlist and track routes, with **no** owner-only guard. A collaborator can mint, list, re-permission and revoke share links across the locker's playlists.

Note the consequence, which is intended: a collaborator can mint an **edit** link, and can revoke a link the owner created. Share links are locker-level state, not per-creator state — the same way tracks are.

- [ ] **Step 1: Write the failing test**

Append to `packages/api/src/routes/membership.test.ts`:

```ts
describe("sharing under collaboration", () => {
  it("lets a collaborator mint a share link on the owner's playlist", async () => {
    const res = await app.request(
      "/shares",
      {
        method: "POST",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ playlistId: ownerPlaylistId, permission: "edit" }),
      },
      env
    );
    expect(res.status).toBe(201);
    const { share } = (await res.json()) as { share: { permission: string } };
    expect(share.permission).toBe("edit");
  });

  it("shows the locker's share links to a collaborator", async () => {
    const res = await app.request("/shares", { headers: auth(collabToken) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shares: { playlistId: string }[] };
    expect(body.shares.length).toBeGreaterThan(0);
    expect(body.shares.every((s) => s.playlistId === ownerPlaylistId)).toBe(true);
  });

  it("still refuses a stranger minting one", async () => {
    const res = await app.request(
      "/shares",
      {
        method: "POST",
        headers: { ...auth(strangerToken), "Content-Type": "application/json" },
        body: JSON.stringify({ playlistId: ownerPlaylistId, permission: "listen" }),
      },
      env
    );
    expect(res.status).toBe(404);
  });

  it("returns no shares to a stranger listing them", async () => {
    const res = await app.request("/shares", { headers: auth(strangerToken) }, env);
    const body = (await res.json()) as { shares: unknown[] };
    expect(body.shares).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w packages/api -- membership.test.ts`
Expected: FAIL — the collaborator's POST 404s and their share list is empty, because both compare against `userId` rather than the locker.

- [ ] **Step 3: Scope the five sites to the locker**

In `packages/api/src/routes/shares.ts`, import `lockerIdOf` from `../lib/locker.js`, and in each of the five authenticated handlers replace the acting id with the locker id:

```ts
  const lockerId = lockerIdOf(c.get("user"));
```

Then, at lines ~31, ~110, ~134 and ~165 (the playlist ownership lookups in `POST /`, `PATCH /:id`, `GET /playlist/:playlistId` and `DELETE /:id`):

```ts
  if (!playlist || playlist.ownerId !== lockerId) {
    return c.json({ error: "not found" }, 404);
  }
```

and at line ~83 (`GET /`, the all-shares list):

```ts
    .where(eq(playlists.ownerId, lockerId));
```

`GET /shares/invite/:token` is unauthenticated and must not change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/api`
Expected: PASS.

- [ ] **Step 5: Root typecheck**

Run: `npm run typecheck` from the repo root.
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/shares.ts packages/api/src/routes/membership.test.ts
git commit -m "feat(api): share management is owner-only under collaboration"
```

---

### Task 6: Delete guards — you may only destroy what you created

**Files:**
- Modify: `packages/api/src/routes/tracks.ts:286` (DELETE), `packages/api/src/routes/playlists.ts:215` (DELETE)
- Test: `packages/api/src/routes/membership.test.ts` (extend)

**Interfaces:**
- Consumes: `tracks.uploadedBy`, `playlists.createdBy` (Task 1), `lockerIdOf`/`isLockerOwner` (Task 2).
- Produces: nothing new.

**This is the task where a bug destroys someone's masters.** `DELETE /tracks/:id` erases `originalKey` (the lossless master) and `streamKey` from the bucket, then the row — no soft delete, no undo. The guard must fail closed.

Rule: the locker **owner** may delete anything in their locker. A **collaborator** may delete a track only when `uploadedBy === their own id`, and a playlist only when `createdBy === their own id`. A null `uploadedBy`/`createdBy` reads as the owner's, so a collaborator may not delete it.

Deleting a playlist is not destructive — migration 0003's `ON DELETE SET NULL` detaches its tracks — so that guard is consistency, not data safety.

- [ ] **Step 1: Write the failing test**

Append to `packages/api/src/routes/membership.test.ts`:

```ts
describe("delete is limited to what you created", () => {
  it("refuses to let a collaborator delete the owner's track, and keeps the file", async () => {
    const bucket = env.DEMOS_BUCKET as { put: Function; get: Function };
    await bucket.put("lib/precious", Buffer.from("MASTER"), {
      httpMetadata: { contentType: "audio/wav" },
    });
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "owner master",
        position: 0,
        originalKey: "lib/precious",
        uploadedBy: ownerId,
      })
      .returning();

    const res = await app.request(
      `/tracks/${tr.id}`,
      { method: "DELETE", headers: auth(collabToken) },
      env
    );
    expect(res.status).toBe(404);

    const [still] = await db.select().from(tracks).where(eq(tracks.id, tr.id));
    expect(still).toBeDefined();
    expect(await bucket.get("lib/precious")).not.toBeNull();
  });

  it("lets a collaborator delete a track they uploaded themselves", async () => {
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "collab master",
        position: 0,
        originalKey: "lib/collab-own",
        uploadedBy: collabId,
      })
      .returning();

    const res = await app.request(
      `/tracks/${tr.id}`,
      { method: "DELETE", headers: auth(collabToken) },
      env
    );
    expect(res.status).toBe(200);
    const [gone] = await db.select().from(tracks).where(eq(tracks.id, tr.id));
    expect(gone).toBeUndefined();
  });

  it("lets the owner delete a collaborator's track", async () => {
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "collab upload, owner deletes",
        position: 0,
        originalKey: "lib/owner-can",
        uploadedBy: collabId,
      })
      .returning();

    const res = await app.request(
      `/tracks/${tr.id}`,
      { method: "DELETE", headers: auth(ownerToken) },
      env
    );
    expect(res.status).toBe(200);
  });

  it("refuses to let a collaborator delete a playlist they did not create", async () => {
    const res = await app.request(
      `/playlists/${ownerPlaylistId}`,
      { method: "DELETE", headers: auth(collabToken) },
      env
    );
    expect(res.status).toBe(404);
    const [still] = await db.select().from(playlists).where(eq(playlists.id, ownerPlaylistId));
    expect(still).toBeDefined();
  });

  it("lets a collaborator delete a playlist they created", async () => {
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId, name: "collab's own", createdBy: collabId })
      .returning();

    const res = await app.request(
      `/playlists/${pl.id}`,
      { method: "DELETE", headers: auth(collabToken) },
      env
    );
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w packages/api -- membership.test.ts`
Expected: FAIL — right now the collaborator 404s on *every* delete (their id isn't the owner's), so the "can delete their own" cases fail.

- [ ] **Step 3: Implement the guards**

`packages/api/src/routes/tracks.ts`, the `DELETE /:id` handler:

```ts
  const user = c.get("user");
  const lockerId = lockerIdOf(user);

  const [track] = await db
    .select()
    .from(tracks)
    .where(eq(tracks.id, id))
    .limit(1);

  // Wrong locker entirely.
  if (!track || track.ownerId !== lockerId) {
    return c.json({ error: "not found" }, 404);
  }

  // Deleting a track erases the lossless master from the bucket with no undo,
  // so a collaborator may only ever destroy their own upload. A null
  // uploadedBy predates attribution (or its uploader has been removed) and
  // reads as the owner's — which means a collaborator may not touch it.
  if (!isLockerOwner(user) && track.uploadedBy !== user.id) {
    return c.json({ error: "not found" }, 404);
  }
```

`packages/api/src/routes/playlists.ts`, the `DELETE /:id` handler:

```ts
  const user = c.get("user");
  const lockerId = lockerIdOf(user);
  // ...
  if (!playlist || playlist.ownerId !== lockerId) {
    return c.json({ error: "not found" }, 404);
  }
  if (!isLockerOwner(user) && playlist.createdBy !== user.id) {
    return c.json({ error: "not found" }, 404);
  }
```

Import `lockerIdOf` and `isLockerOwner` in both files if not already present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/api`
Expected: PASS.

- [ ] **Step 5: Mutation-check both guards**

This is not optional. A test that still passes with the fix removed is not a test.

1. Comment out the `!isLockerOwner(user) && track.uploadedBy !== user.id` block in `tracks.ts`.
2. Run `npm test -w packages/api -- membership.test.ts`.
3. **Expected: FAIL** on "refuses to let a collaborator delete the owner's track". If it passes, the test is not exercising the guard — fix the test before restoring the code.
4. Restore the block. Repeat for the `playlists.ts` guard against "refuses to let a collaborator delete a playlist they did not create".
5. Run the suite once more and confirm green.

- [ ] **Step 6: Root typecheck**

Run: `npm run typecheck` from the repo root.
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/tracks.ts packages/api/src/routes/playlists.ts packages/api/src/routes/membership.test.ts
git commit -m "feat(api): collaborators may only delete what they created"
```

---

### Task 7: Collaborator invites — mint, list, revoke

**Files:**
- Create: `packages/api/src/routes/collab.ts`, `packages/api/src/routes/collab.test.ts`
- Modify: `packages/api/src/index.ts`, `docs/openapi.json`, `AGENTS.md`
- Test: `packages/api/src/routes/collab.test.ts`

**Interfaces:**
- Consumes: `collaboratorInvites` (Task 1), `isLockerOwner`/`lockerIdOf` (Task 2), `getLimits`/`isLimited` from `lib/limits.js`.
- Produces, all owner-only, mounted at `/collab`:
  - `POST /collab/invites` `{label: string}` → `201 {invite: {id, label, token, createdAt}}`
  - `GET /collab/invites` → `200 {invites: [{id, label, createdAt, acceptedAt}]}`
  - `DELETE /collab/invites/:id` → `200 {ok: true}`
  - `GET /collab/members` → `200 {members: [{id, email, createdAt}]}`
  - `DELETE /collab/members/:id` → `200 {ok: true}`

Redemption is Task 8. This task ships the owner's side only.

**On `MAX_COLLABORATORS`:** the binding already exists in `types.ts` and `lib/limits.ts`, where it currently caps share links per playlist. Reuse it here to cap `members + pending invites` per locker, so an instance operator has a lever. Unset (0) means unlimited, per `isLimited`.

**Revoking a member deletes their user row.** Sessions cascade (they are logged out), and `uploaded_by`/`created_by` go SET NULL, so their music stays in the owner's library and reads as the owner's. That is deliberate: the files belong to the locker.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/routes/collab.test.ts`:

```ts
// The owner's side of collaboration: mint an invite, see who is pending and
// who has joined, and remove either. Redemption lives in auth.test coverage.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";
import { createFsBucket } from "../lib/storage-fs.js";
import { users, sessions, tracks, collaboratorInvites } from "../db/schema.js";

let db: Database;
let root: string;
let env: Record<string, unknown>;
let ownerId: string;
let ownerToken: string;
let collabToken: string;

beforeAll(async () => {
  db = createSqliteDb();
  setDbFactory(() => db);
  root = await mkdtemp(join(tmpdir(), "dl-collab-"));
  env = { DB: "sqlite", DEMOS_BUCKET: createFsBucket(root) };

  const [owner] = await db
    .insert(users)
    .values({ email: "collab-owner@test.dev", passwordHash: "x" })
    .returning();
  ownerId = owner.id;
  const [collab] = await db
    .insert(users)
    .values({ email: "collab-member@test.dev", passwordHash: "x", lockerOwnerId: owner.id })
    .returning();

  const future = new Date(Date.now() + 1000 * 60 * 60);
  ownerToken = "collab-owner-token";
  collabToken = "collab-member-token";
  await db.insert(sessions).values({ userId: owner.id, token: ownerToken, expiresAt: future });
  await db.insert(sessions).values({ userId: collab.id, token: collabToken, expiresAt: future });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("POST /collab/invites", () => {
  it("mints a labelled invite for the owner", async () => {
    const res = await app.request(
      "/collab/invites",
      {
        method: "POST",
        headers: { ...auth(ownerToken), "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Jimmy" }),
      },
      env
    );
    expect(res.status).toBe(201);
    const { invite } = (await res.json()) as { invite: { label: string; token: string } };
    expect(invite.label).toBe("Jimmy");
    expect(invite.token).toMatch(/^[a-f0-9]{32}$/);
  });

  it("requires a label", async () => {
    const res = await app.request(
      "/collab/invites",
      {
        method: "POST",
        headers: { ...auth(ownerToken), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      env
    );
    expect(res.status).toBe(400);
  });

  it("refuses a collaborator inviting further collaborators", async () => {
    const res = await app.request(
      "/collab/invites",
      {
        method: "POST",
        headers: { ...auth(collabToken), "Content-Type": "application/json" },
        body: JSON.stringify({ label: "chain" }),
      },
      env
    );
    expect(res.status).toBe(404);
  });

  it("401s with no session", async () => {
    const res = await app.request(
      "/collab/invites",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "anon" }),
      },
      env
    );
    expect(res.status).toBe(401);
  });

  it("enforces MAX_COLLABORATORS across members and pending invites", async () => {
    const capped = { ...env, MAX_COLLABORATORS: "1" };
    const res = await app.request(
      "/collab/invites",
      {
        method: "POST",
        headers: { ...auth(ownerToken), "Content-Type": "application/json" },
        body: JSON.stringify({ label: "one too many" }),
      },
      capped
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /collab/members", () => {
  it("lists the locker's collaborators without password hashes", async () => {
    const res = await app.request("/collab/members", { headers: auth(ownerToken) }, env);
    expect(res.status).toBe(200);
    const { members } = (await res.json()) as { members: Record<string, unknown>[] };
    expect(members.map((m) => m.email)).toContain("collab-member@test.dev");
    expect(members[0]).not.toHaveProperty("passwordHash");
  });
});

describe("DELETE /collab/members/:id", () => {
  it("removes the collaborator but keeps their uploads in the library", async () => {
    const [gone] = await db
      .insert(users)
      .values({ email: "leaving@test.dev", passwordHash: "x", lockerOwnerId: ownerId })
      .returning();
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId,
        title: "left behind",
        position: 0,
        originalKey: "lib/left-behind",
        uploadedBy: gone.id,
      })
      .returning();

    const res = await app.request(
      `/collab/members/${gone.id}`,
      { method: "DELETE", headers: auth(ownerToken) },
      env
    );
    expect(res.status).toBe(200);

    const [user] = await db.select().from(users).where(eq(users.id, gone.id));
    expect(user).toBeUndefined();

    const [track] = await db.select().from(tracks).where(eq(tracks.id, tr.id));
    expect(track).toBeDefined();
    expect(track.uploadedBy).toBeNull();
    expect(track.ownerId).toBe(ownerId);
  });

  it("404s removing a user who is not in this locker", async () => {
    const [outsider] = await db
      .insert(users)
      .values({ email: "outsider@test.dev", passwordHash: "x" })
      .returning();

    const res = await app.request(
      `/collab/members/${outsider.id}`,
      { method: "DELETE", headers: auth(ownerToken) },
      env
    );
    expect(res.status).toBe(404);

    const [still] = await db.select().from(users).where(eq(users.id, outsider.id));
    expect(still).toBeDefined();
  });
});

describe("DELETE /collab/invites/:id", () => {
  it("revokes a pending invite", async () => {
    const [inv] = await db
      .insert(collaboratorInvites)
      .values({ ownerId, token: "revoke-me-token", label: "nope" })
      .returning();

    const res = await app.request(
      `/collab/invites/${inv.id}`,
      { method: "DELETE", headers: auth(ownerToken) },
      env
    );
    expect(res.status).toBe(200);

    const [gone] = await db
      .select()
      .from(collaboratorInvites)
      .where(eq(collaboratorInvites.id, inv.id));
    expect(gone).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w packages/api -- collab.test.ts`
Expected: FAIL — every request 404s, the router does not exist.

- [ ] **Step 3: Write the router**

Create `packages/api/src/routes/collab.ts`:

```ts
// Collaborators: people who share this locker's library.
//
// Every route here is owner-only. A collaborator can use the library but
// cannot change who else is in it — no invite chaining, no removing peers.
// Denials return the same non-enumerable 404 the rest of the private API uses.

import { Hono } from "hono";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { users, collaboratorInvites } from "../db/schema.js";
import { requireAuth } from "../lib/session.js";
import { isLockerOwner } from "../lib/locker.js";
import { getLimits, isLimited } from "../lib/limits.js";
import type { Env } from "../types.js";

const collabRouter = new Hono<Env>();

const MAX_LABEL_CHARS = 100;

collabRouter.post("/invites", requireAuth, async (c) => {
  const user = c.get("user");
  if (!isLockerOwner(user)) return c.json({ error: "not found" }, 404);

  const { label } = await c.req.json();
  if (!label || typeof label !== "string" || !label.trim()) {
    return c.json({ error: "label required" }, 400);
  }
  if (label.length > MAX_LABEL_CHARS) {
    return c.json({ error: `label must be ${MAX_LABEL_CHARS} characters or fewer` }, 400);
  }

  const db = getDb(c.env.DB);

  // The cap counts people who are already in plus invitations still
  // outstanding — otherwise an owner could mint unlimited invites and blow
  // past the limit at redemption time.
  const limits = getLimits(c.env);
  if (isLimited(limits.maxCollaborators)) {
    const [members] = await db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.lockerOwnerId, user.id));
    const [pending] = await db
      .select({ count: sql<number>`count(*)` })
      .from(collaboratorInvites)
      .where(
        and(eq(collaboratorInvites.ownerId, user.id), isNull(collaboratorInvites.acceptedAt))
      );

    const used = Number(members?.count ?? 0) + Number(pending?.count ?? 0);
    if (used >= limits.maxCollaborators) {
      return c.json(
        { error: `this instance limits lockers to ${limits.maxCollaborators} collaborators` },
        403
      );
    }
  }

  const token = crypto.randomUUID().replace(/-/g, "");
  const [invite] = await db
    .insert(collaboratorInvites)
    .values({ ownerId: user.id, token, label: label.trim() })
    .returning();

  return c.json({ invite }, 201);
});

collabRouter.get("/invites", requireAuth, async (c) => {
  const user = c.get("user");
  if (!isLockerOwner(user)) return c.json({ error: "not found" }, 404);

  const db = getDb(c.env.DB);
  const invites = await db
    .select({
      id: collaboratorInvites.id,
      label: collaboratorInvites.label,
      token: collaboratorInvites.token,
      createdAt: collaboratorInvites.createdAt,
      acceptedAt: collaboratorInvites.acceptedAt,
    })
    .from(collaboratorInvites)
    .where(eq(collaboratorInvites.ownerId, user.id));

  return c.json({ invites });
});

collabRouter.delete("/invites/:id", requireAuth, async (c) => {
  const user = c.get("user");
  if (!isLockerOwner(user)) return c.json({ error: "not found" }, 404);

  const db = getDb(c.env.DB);
  const [invite] = await db
    .select({ id: collaboratorInvites.id })
    .from(collaboratorInvites)
    .where(
      and(
        eq(collaboratorInvites.id, c.req.param("id")),
        eq(collaboratorInvites.ownerId, user.id)
      )
    )
    .limit(1);
  if (!invite) return c.json({ error: "not found" }, 404);

  await db.delete(collaboratorInvites).where(eq(collaboratorInvites.id, invite.id));
  return c.json({ ok: true });
});

collabRouter.get("/members", requireAuth, async (c) => {
  const user = c.get("user");
  if (!isLockerOwner(user)) return c.json({ error: "not found" }, 404);

  const db = getDb(c.env.DB);
  const members = await db
    .select({ id: users.id, email: users.email, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.lockerOwnerId, user.id));

  return c.json({ members });
});

// Removing a collaborator deletes their account: sessions cascade so they are
// signed out, while uploaded_by / created_by go SET NULL. Their music stays in
// the library and reads as the owner's — the files belong to the locker, not
// to the person who happened to upload them.
collabRouter.delete("/members/:id", requireAuth, async (c) => {
  const user = c.get("user");
  if (!isLockerOwner(user)) return c.json({ error: "not found" }, 404);

  const db = getDb(c.env.DB);
  const [member] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, c.req.param("id")), eq(users.lockerOwnerId, user.id)))
    .limit(1);
  if (!member) return c.json({ error: "not found" }, 404);

  await db.delete(users).where(eq(users.id, member.id));
  return c.json({ ok: true });
});

export default collabRouter;
```

- [ ] **Step 4: Mount the router**

In `packages/api/src/index.ts`, alongside the existing `app.route()` mounts:

```ts
import collabRouter from "./routes/collab.js";
// ...
app.route("/collab", collabRouter);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w packages/api`
Expected: PASS.

- [ ] **Step 6: Document the five routes**

Add all five paths to `docs/openapi.json` following the shape of the existing `/shares` entries — `summary`, `security` (bearer), request body schema for the POST, and the response schemas above. Add a **Collaborators** section to `AGENTS.md` describing the invite → join → shared-library flow and the delete rule.

- [ ] **Step 7: Root typecheck and lint**

Run: `npm run typecheck` and `npm run lint` from the repo root.
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/routes/collab.ts packages/api/src/routes/collab.test.ts packages/api/src/index.ts docs/openapi.json AGENTS.md
git commit -m "feat(api): collaborator invites and member management"
```

---

### Task 8: Redeem an invite at signup

**Files:**
- Modify: `packages/api/src/routes/auth.ts:25-67`, `packages/api/src/lib/signup.ts`, `docs/openapi.json`
- Test: `packages/api/src/routes/collab.test.ts` (extend)

**Interfaces:**
- Consumes: `collaboratorInvites` (Task 1), `signupAllowed` (existing).
- Produces: `POST /auth/signup` accepts an optional `inviteToken`. With a valid unredeemed one, it creates a user whose `lockerOwnerId` is the invite's owner and marks the invite accepted — **even though registration is otherwise closed**.

**The gate order matters.** Today signup is: closed-check → duplicate-email → create. It becomes: if `inviteToken` present, resolve it and *bypass* the closed-check; otherwise apply the closed-check unchanged. An invalid or already-redeemed token must **not** fall through to the normal path — it fails outright, or a spent invite would silently become an ordinary signup attempt on an open instance.

The existing `rateLimit("signup", SIGNUP_RULE)` middleware already meters this route per IP, so invite-token guessing is metered for free. Do not remove it.

- [ ] **Step 1: Write the failing test**

Append to `packages/api/src/routes/collab.test.ts`:

```ts
describe("POST /auth/signup with an invite", () => {
  it("creates a collaborator bound to the inviting owner's locker", async () => {
    await db
      .insert(collaboratorInvites)
      .values({ ownerId, token: "good-invite-token", label: "Dana" });

    const res = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "dana@test.dev",
          password: "correct horse",
          inviteToken: "good-invite-token",
        }),
      },
      env
    );
    expect(res.status).toBe(201);
    const { user } = (await res.json()) as { user: { id: string; lockerOwnerId: string } };
    expect(user.lockerOwnerId).toBe(ownerId);

    const [invite] = await db
      .select()
      .from(collaboratorInvites)
      .where(eq(collaboratorInvites.token, "good-invite-token"));
    expect(invite.acceptedBy).toBe(user.id);
    expect(invite.acceptedAt).not.toBeNull();
  });

  it("refuses a second redemption of the same invite", async () => {
    const res = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "second@test.dev",
          password: "correct horse",
          inviteToken: "good-invite-token",
        }),
      },
      env
    );
    expect(res.status).toBe(403);

    const [none] = await db.select().from(users).where(eq(users.email, "second@test.dev"));
    expect(none).toBeUndefined();
  });

  it("refuses an unknown invite token rather than falling through to normal signup", async () => {
    const res = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "nobody@test.dev",
          password: "correct horse",
          inviteToken: "no-such-token",
        }),
      },
      env
    );
    expect(res.status).toBe(403);

    const [none] = await db.select().from(users).where(eq(users.email, "nobody@test.dev"));
    expect(none).toBeUndefined();
  });

  it("still refuses an ordinary signup on a closed instance", async () => {
    const res = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "walkup@test.dev", password: "correct horse" }),
      },
      env
    );
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w packages/api -- collab.test.ts`
Expected: FAIL — `inviteToken` is ignored, so the invited signup 403s on the closed-registration gate.

- [ ] **Step 3: Add invite resolution to lib/signup.ts**

```ts
import { and, eq, isNull, sql } from "drizzle-orm";
import { collaboratorInvites } from "../db/schema.js";

export type ResolvedInvite = { id: string; ownerId: string };

// An unredeemed, unexpired invite. Returns null for unknown, spent, or expired
// tokens — the caller must treat all three the same way and must NOT fall back
// to the ordinary signup path, or a spent invite would quietly become a normal
// registration attempt on an instance that has reopened signup.
export async function resolveInvite(
  db: Database,
  token: string
): Promise<ResolvedInvite | null> {
  const [invite] = await db
    .select({
      id: collaboratorInvites.id,
      ownerId: collaboratorInvites.ownerId,
      expiresAt: collaboratorInvites.expiresAt,
    })
    .from(collaboratorInvites)
    .where(
      and(eq(collaboratorInvites.token, token), isNull(collaboratorInvites.acceptedAt))
    )
    .limit(1);

  if (!invite) return null;
  if (invite.expiresAt && invite.expiresAt < new Date()) return null;
  return { id: invite.id, ownerId: invite.ownerId };
}
```

- [ ] **Step 4: Wire it into the signup route**

In `packages/api/src/routes/auth.ts`, replace the closed-registration gate:

```ts
  const { email, password, inviteToken } = await c.req.json();
  // ... existing email/password validation unchanged ...

  const db = getDb(c.env.DB);

  // An invite is its own authorisation to create an account, so it bypasses
  // the closed-registration gate — but an invalid or already-redeemed token
  // must fail outright rather than falling through to the ordinary path.
  let invite = null;
  if (inviteToken) {
    invite = await resolveInvite(db, inviteToken);
    if (!invite) {
      return c.json({ error: "this invite is not valid" }, 403);
    }
  } else if (!(await signupAllowed(db, c.env))) {
    return c.json({ error: "registration is closed on this instance" }, 403);
  }
```

The insert gains the binding, and the returned user carries it:

```ts
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash, lockerOwnerId: invite?.ownerId ?? null })
    .returning({
      id: users.id,
      email: users.email,
      accent: users.accent,
      lockerOwnerId: users.lockerOwnerId,
    });

  if (invite) {
    await db
      .update(collaboratorInvites)
      .set({ acceptedBy: user.id, acceptedAt: new Date() })
      .where(eq(collaboratorInvites.id, invite.id));
  }
```

Import `resolveInvite` from `../lib/signup.js` and `collaboratorInvites` from `../db/schema.js`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w packages/api`
Expected: PASS, including the existing `security.test.ts` closed-signup assertions.

- [ ] **Step 6: Mutation-check the single-use guard**

1. Change `isNull(collaboratorInvites.acceptedAt)` in `resolveInvite` to drop that condition.
2. Run `npm test -w packages/api -- collab.test.ts`.
3. **Expected: FAIL** on "refuses a second redemption". Restore it and confirm green.

- [ ] **Step 7: Document and typecheck**

Add `inviteToken` to the `/auth/signup` request schema in `docs/openapi.json`.
Run: `npm run typecheck` from the repo root. Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/routes/auth.ts packages/api/src/lib/signup.ts packages/api/src/routes/collab.test.ts docs/openapi.json
git commit -m "feat(api): redeem a collaborator invite at signup"
```

---

### Task 9: Rename a playlist, and fix the client-side owner check

**Files:**
- Modify: `packages/web/src/pages/PlaylistView.tsx` (lines 43, 116, 186, 207, and around 115)
- Test: `packages/web/src/pages/PlaylistView.rename.test.tsx` (created here)

**Interfaces:**
- Consumes: `playlists.update(id, {name})` in `packages/web/src/lib/api.ts:136` — already exists, already typed, never called with a name. Also `User.lockerOwnerId` (Task 11 adds it to the web `User` type; if Task 11 has not run yet, add the field here and let Task 11 find it present).
- Produces: nothing for later tasks.

**The client-side check is wrong for collaborators.** `PlaylistView.tsx:43` computes:

```tsx
const isOwner = !!playlist && !!currentUserId && playlist.ownerId === currentUserId;
```

For a collaborator, `playlist.ownerId` is the *locker owner's* id and `currentUserId` is theirs, so `isOwner` is false and they silently lose every control gated on it — including `[+ add tracks]` at line 207, which is exactly the "organise tracklists into playlists" capability DL asked for.

Split the one flag into two, mirroring the server:

```tsx
// Same resolution the API does in lib/locker.ts: which locker am I acting in?
const lockerId = currentUser ? (currentUser.lockerOwnerId ?? currentUser.id) : null;

// May act on this locker's library: add tracks, reorder, rename, share.
const canManage = !!playlist && !!lockerId && playlist.ownerId === lockerId;

// Owns the locker outright. Gates publishing only — a collaborator may share a
// playlist but may not put it on the open web (DL, 2026-08-07).
const isOwner = !!playlist && !!currentUserId && playlist.ownerId === currentUserId;
```

Then:
- **Line 116** (`[make public]` / `[make private]`) stays on `isOwner`.
- **Line 207** (`[+ add tracks]`) moves to `canManage`.
- **Line 186 and 250** (`<Comments isOwner={...}>`) stay on `isOwner` for now. Comment resolve/delete was not part of DL's ask and widening it is a product decision nobody has made. Note it in the task's commit message as knowingly deferred.
- `<SharePanel>` is already ungated and needs no change — collaborators may share, per DL.

The title renders as figlet art through `AsciiText`, which is a `container-type: inline-size` element inside a `flex: 1` column. **Do not make the ASCII element itself editable** — swap a plain `<input>` in for it while editing and put the art back on commit. Anything else risks the collapse-to-zero trap that has bitten this component three times.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/pages/PlaylistView.rename.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import PlaylistView from "./PlaylistView";
import * as api from "../lib/api";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof api>("../lib/api");
  return {
    ...actual,
    playlists: {
      get: vi.fn(),
      update: vi.fn(),
    },
    shares: { forPlaylist: vi.fn().mockResolvedValue({ shares: [] }) },
    tracks: { list: vi.fn().mockResolvedValue({ tracks: [] }) },
  };
});

const playlist = {
  id: "pl-1",
  name: "old name",
  ownerId: "u-1",
  artworkKey: null,
  isPublic: false,
  createdAt: "",
  updatedAt: "",
};

beforeEach(() => {
  vi.mocked(api.playlists.get).mockResolvedValue({ playlist, tracks: [] });
  vi.mocked(api.playlists.update).mockResolvedValue({
    playlist: { ...playlist, name: "new name" },
  });
});

describe("playlist rename", () => {
  it("commits a new name on Enter", async () => {
    render(<PlaylistView playlistId="pl-1" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /rename/i }));

    const input = screen.getByRole("textbox", { name: /playlist name/i });
    fireEvent.change(input, { target: { value: "new name" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(api.playlists.update).toHaveBeenCalledWith("pl-1", { name: "new name" })
    );
  });

  it("discards the edit on Escape without calling the API", async () => {
    render(<PlaylistView playlistId="pl-1" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /rename/i }));

    const input = screen.getByRole("textbox", { name: /playlist name/i });
    fireEvent.change(input, { target: { value: "abandoned" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(api.playlists.update).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });

  it("does not submit an empty name", async () => {
    render(<PlaylistView playlistId="pl-1" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /rename/i }));

    const input = screen.getByRole("textbox", { name: /playlist name/i });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(api.playlists.update).not.toHaveBeenCalled();
  });
});
```

Match the props `PlaylistView` actually takes — read the component's signature first and adjust the two `render()` calls if they differ.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w packages/web -- PlaylistView.rename`
Expected: FAIL — there is no `[rename]` button.

- [ ] **Step 3: Add the rename control**

In `PlaylistView.tsx`, add state near the other `useState` calls:

```tsx
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renameError, setRenameError] = useState("");

  async function commitRename() {
    const next = draftName.trim();
    if (!next || next === playlist.name) {
      setRenaming(false);
      return;
    }
    try {
      const r = await playlistsApi.update(playlist.id, { name: next });
      setPlaylist(r.playlist);
      setRenaming(false);
      setRenameError("");
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "rename failed");
    }
  }
```

Replace the `<AsciiText text={playlist.name} />` line and the block below it:

```tsx
        <div style={{ flex: 1, minWidth: 0 }}>
          {renaming ? (
            <input
              aria-label="playlist name"
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") {
                  setRenaming(false);
                  setRenameError("");
                }
              }}
              onBlur={() => setRenaming(false)}
              className="rename-input"
            />
          ) : (
            <AsciiText text={playlist.name} />
          )}
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.4rem" }}>
            {!renaming && (
              <button
                onClick={() => {
                  setDraftName(playlist.name);
                  setRenaming(true);
                }}
                style={{ ...linkStyle, color: "var(--accent)" }}
              >
                [rename]
              </button>
            )}
            {isOwner && (
              <button
                onClick={togglePublic}
                style={{ ...linkStyle, color: "var(--accent)" }}
              >
                [{playlist.isPublic ? "make private" : "make public"}]
              </button>
            )}
          </div>
          {renameError && (
            <div style={{ color: "#f44", fontSize: "12px" }}>{renameError}</div>
          )}
        </div>
```

Add to the stylesheet:

```css
/* The ascii title is a size container; the rename input stands in for it
   rather than wrapping it, so the container never sizes itself from an
   editable child. width:100% keeps it inside the flex:1 column. */
.rename-input {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg);
  font-family: var(--font);
  font-size: 16px;
  padding: 0.3rem 0.4rem;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/web`
Expected: PASS.

- [ ] **Step 5: Root typecheck**

Run: `npm run typecheck` from the repo root.
Expected: clean. Note `packages/web` uses `tsc -b --noEmit` — a solution-style tsconfig with `tsc --noEmit` compiles zero files and reports vacuous success.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/pages/PlaylistView.tsx packages/web/src/pages/PlaylistView.rename.test.tsx packages/web/src/index.css
git commit -m "feat(web): rename a playlist, and resolve the locker for collaborators

Splits isOwner into canManage (library work) and isOwner (publishing).
Comment resolve/delete stays owner-only — knowingly deferred, not decided."
```

---

### Task 10: Mint edit share links, with a label

**Files:**
- Modify: `packages/web/src/components/SharePanel.tsx:26`, `packages/web/src/lib/api.ts`
- Test: `packages/web/src/components/SharePanel.test.tsx` (created here)

**Interfaces:**
- Consumes: `shares.create(playlistId, permission, email?)` at `lib/api.ts:306` — already accepts both arguments.
- Produces: nothing for later tasks.

Today `[+ share link]` hardcodes `"listen"` and sends no email, so the access list on Home is a row of anonymous tokens and edit can only be granted two pages away. This task makes the panel mint either permission and attach a name.

`shares.email` is the existing column; it is used purely as a display label (`SharePanel` already renders `share.email || "anyone with link"`). Nothing is sent to it. The input is labelled "who is this for?" rather than "email" to match what it does.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/SharePanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SharePanel from "./SharePanel";
import * as api from "../lib/api";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof api>("../lib/api");
  return {
    ...actual,
    shares: {
      forPlaylist: vi.fn().mockResolvedValue({ shares: [] }),
      create: vi.fn().mockResolvedValue({ share: {} }),
      revoke: vi.fn(),
    },
  };
});

beforeEach(() => {
  vi.mocked(api.shares.create).mockClear();
});

describe("SharePanel", () => {
  it("mints a listen link by default", async () => {
    render(<SharePanel playlistId="pl-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /share link/i }));
    await waitFor(() =>
      expect(api.shares.create).toHaveBeenCalledWith("pl-1", "listen", undefined)
    );
  });

  it("mints an edit link when edit is selected", async () => {
    render(<SharePanel playlistId="pl-1" />);
    fireEvent.click(await screen.findByLabelText(/can upload and reorder/i));
    fireEvent.click(screen.getByRole("button", { name: /share link/i }));
    await waitFor(() =>
      expect(api.shares.create).toHaveBeenCalledWith("pl-1", "edit", undefined)
    );
  });

  it("attaches the label so the link is identifiable later", async () => {
    render(<SharePanel playlistId="pl-1" />);
    fireEvent.change(await screen.findByLabelText(/who is this for/i), {
      target: { value: "Jimmy" },
    });
    fireEvent.click(screen.getByRole("button", { name: /share link/i }));
    await waitFor(() =>
      expect(api.shares.create).toHaveBeenCalledWith("pl-1", "listen", "Jimmy")
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w packages/web -- SharePanel`
Expected: FAIL — no checkbox, no label input, and `create` is called with two arguments.

- [ ] **Step 3: Implement**

In `SharePanel.tsx`, add state and rewrite `handleCreate`:

```tsx
  const [canEdit, setCanEdit] = useState(false);
  const [label, setLabel] = useState("");

  async function handleCreate() {
    setError("");
    try {
      await api.create(playlistId, canEdit ? "edit" : "listen", label.trim() || undefined);
      setLabel("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    }
  }
```

Replace the `.share-actions` block:

```tsx
      <div className="share-actions">
        <input
          aria-label="who is this for?"
          placeholder="who is this for?"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="share-label-input"
        />
        <label className="share-perm">
          <input
            type="checkbox"
            aria-label="can upload and reorder"
            checked={canEdit}
            onChange={(e) => setCanEdit(e.target.checked)}
          />
          can upload and reorder
        </label>
        <button onClick={handleCreate} className="tui-btn">
          [+ share link]
        </button>
        {extraAction}
      </div>
```

Delete the `.share-hint` span — it pointed at the access panel as a workaround for exactly the gap this closes. Its CSS rule can stay; it is harmless and may be used elsewhere. Grep before removing it.

Add:

```css
.share-label-input {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg);
  font-family: var(--font);
  font-size: 12px;
  padding: 0.2rem 0.4rem;
  flex: none;
  width: 14ch;
}
.share-perm {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  color: var(--fg-dim);
  font-size: 12px;
  white-space: nowrap;
  flex: none;
}
```

`white-space: nowrap` and `flex: none` are deliberate — `.share-actions` is a flex row where unconstrained items previously wrapped mid-label into different heights.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/web`
Expected: PASS.

- [ ] **Step 5: Check the row at 320px**

Run the dev server and narrow the viewport to 320px with a playlist open. Confirm `.share-actions` does not overflow: in the console, `const el = document.querySelector('.share-actions'); el.scrollWidth <= el.clientWidth` must be `true`. A screenshot is not sufficient — a row can overflow while looking fine.

- [ ] **Step 6: Root typecheck**

Run: `npm run typecheck` from the repo root.
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/SharePanel.tsx packages/web/src/index.css packages/web/src/components/SharePanel.test.tsx
git commit -m "feat(web): mint edit share links and label them where they are made"
```

---

### Task 11: The collaborators panel and the join page

**Files:**
- Create: `packages/web/src/components/CollabPanel.tsx`, `packages/web/src/pages/Join.tsx`, `packages/web/src/components/CollabPanel.test.tsx`
- Modify: `packages/web/src/lib/api.ts`, `packages/web/src/pages/Home.tsx`, `packages/web/src/App.tsx`

**Interfaces:**
- Consumes: the five `/collab` routes (Task 7) and `POST /auth/signup` with `inviteToken` (Task 8).
- Produces: a `collab` client in `lib/api.ts`:

```ts
export type CollabInvite = {
  id: string;
  label: string;
  token: string;
  createdAt: string;
  acceptedAt: string | null;
};
export type CollabMember = { id: string; email: string; createdAt: string };

export const collab = {
  listInvites: () => request<{ invites: CollabInvite[] }>("/collab/invites"),
  invite: (label: string) =>
    request<{ invite: CollabInvite }>("/collab/invites", {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
  revokeInvite: (id: string) => request(`/collab/invites/${id}`, { method: "DELETE" }),
  listMembers: () => request<{ members: CollabMember[] }>("/collab/members"),
  removeMember: (id: string) => request(`/collab/members/${id}`, { method: "DELETE" }),
};
```

`User` in `lib/api.ts` also gains `lockerOwnerId: string | null` so the UI can hide owner-only controls from a signed-in collaborator.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/CollabPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CollabPanel from "./CollabPanel";
import * as api from "../lib/api";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof api>("../lib/api");
  return {
    ...actual,
    collab: {
      listInvites: vi.fn().mockResolvedValue({ invites: [] }),
      listMembers: vi.fn().mockResolvedValue({ members: [] }),
      invite: vi.fn(),
      revokeInvite: vi.fn(),
      removeMember: vi.fn(),
    },
  };
});

beforeEach(() => {
  vi.mocked(api.collab.invite).mockResolvedValue({
    invite: {
      id: "i-1",
      label: "Jimmy",
      token: "tok123",
      createdAt: "",
      acceptedAt: null,
    },
  });
});

describe("CollabPanel", () => {
  it("mints an invite with the typed label", async () => {
    render(<CollabPanel />);
    fireEvent.change(await screen.findByLabelText(/name/i), {
      target: { value: "Jimmy" },
    });
    fireEvent.click(screen.getByRole("button", { name: /invite/i }));
    await waitFor(() => expect(api.collab.invite).toHaveBeenCalledWith("Jimmy"));
  });

  it("will not mint an unlabelled invite", async () => {
    render(<CollabPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /invite/i }));
    expect(api.collab.invite).not.toHaveBeenCalled();
  });

  it("lists members with a remove control", async () => {
    vi.mocked(api.collab.listMembers).mockResolvedValue({
      members: [{ id: "m-1", email: "jimmy@band.dev", createdAt: "" }],
    });
    render(<CollabPanel />);
    expect(await screen.findByText("jimmy@band.dev")).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w packages/web -- CollabPanel`
Expected: FAIL — the component does not exist.

- [ ] **Step 3: Add the api client**

Add the `collab` block above to `packages/web/src/lib/api.ts`, and add `lockerOwnerId: string | null` to the `User` type there.

- [ ] **Step 4: Build CollabPanel**

Create `packages/web/src/components/CollabPanel.tsx`. Requirements, following the visual conventions of the existing access panel in `Home.tsx` (`box` / `box-header`, `[bracket]` buttons, `--fg-dim` for secondary text):

- A `box` headed `collaborators — who shares this locker`.
- A row per member: email, and a two-step `[remove]` → `[remove?]` confirm calling `collab.removeMember(id)`, matching the existing two-step confirm pattern.
- A row per **pending** invite (`acceptedAt === null`): the label, a `[copy link]` button producing `${window.location.origin}/join/${token}` via `copyText` from `lib/copy-text`, and `[revoke]`.
- A footer row: an `aria-label="name"` input plus an `[+ invite]` button. Empty or whitespace-only input does nothing — no API call.
- Copy under the header stating plainly what a collaborator can do: *"collaborators share your library — they can upload tracks, create playlists and organise them. They can only delete what they uploaded themselves."*
- Reload both lists after every mutation. Errors surface in a `#f44` line; never fail silently.

Use `copyText` from `lib/copy-text` rather than `navigator.clipboard` directly — plain-http self-hosts are a supported path and `navigator.clipboard` is undefined outside a secure context.

- [ ] **Step 5: Mount it on Home**

Render `<CollabPanel />` in `Home.tsx` next to the existing `[access]` panel, and gate it on the signed-in user being an owner (`user.lockerOwnerId === null`).

- [ ] **Step 6: Build the join page**

Create `packages/web/src/pages/Join.tsx`: reads the token from the route, shows email + password fields, posts to `auth.signup` with `inviteToken`, and on success stores the session and lands on Home exactly as login does. On failure show the API's error text — an invite that has already been used must say so rather than appearing broken.

Add the route to `App.tsx` alongside the existing `invite` route: a path of `/join/:token` renders `Join`. Follow whatever routing mechanism `App.tsx` already uses — read it first; it is not react-router.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -w packages/web`
Expected: PASS.

- [ ] **Step 8: Root typecheck and lint**

Run: `npm run typecheck` and `npm run lint` from the repo root.
Expected: clean. Watch for `react-hooks/set-state-in-effect` — do not call `setState` synchronously in an effect body; load both lists through a `useCallback` declared above the effect that calls it.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/components/CollabPanel.tsx packages/web/src/components/CollabPanel.test.tsx packages/web/src/pages/Join.tsx packages/web/src/lib/api.ts packages/web/src/pages/Home.tsx packages/web/src/App.tsx
git commit -m "feat(web): collaborator panel and invite redemption page"
```

---

### Task 12: Live verification on the instance

**Files:** none — this task changes no code.

**Interfaces:**
- Consumes: everything above, deployed to `demolocker.dlisok.com`.

Reviews validate reasoning; only use validates behaviour. Every serious defect in this project's history lived where a generated artifact met a real tool, and the worst one was found by an agent actually using the product. A green suite is not the gate.

- [ ] **Step 1: Check migrations before deploying**

Run: `npx wrangler d1 migrations list demo-locker-dlisok-db --remote --config <dir>/wrangler.jsonc`

Read-only. Deploying a Worker ahead of its migration is the one way to hard-break this instance, because drizzle selects every column explicitly — `0003` must be applied **before** the new `worker.js` goes up.

- [ ] **Step 2: Apply the migration, then deploy**

In that order, per the standing two-command rule. Build assets with `bash packages/cli/scripts/build-assets.sh` from the repo root first — `assets/` is gitignored and built at publish time.

- [ ] **Step 3: Wait before verifying**

Do not probe for at least 60 seconds. Requesting an asset before it propagates caches the 404 at the edge — an impatient check both misleads and briefly makes things worse.

- [ ] **Step 4: Walk the flow as a real second person**

In a separate browser profile, so you are genuinely not signed in as DL:

1. As owner: invite "Test Collaborator", copy the join link.
2. In the second profile: redeem it, set a password, land on Home.
3. Confirm the collaborator sees DL's library and playlists.
4. Upload a track as the collaborator. Confirm it appears in DL's view.
5. **Confirm the collaborator cannot delete one of DL's tracks** — the control should not offer it, and the API must 404 if called directly.
6. Confirm the collaborator can delete their own upload.
7. Confirm the collaborator **can** mint a share link, and that opening that link in a logged-out context works.
8. Confirm the collaborator sees **no publish control** and **no collaborators panel** — and that `PATCH /playlists/:id` with `{isPublic:true}` 404s if called directly with their token.
9. Rename a playlist from each account.
10. As owner, remove the collaborator. Confirm they are signed out and **their uploaded track is still in the library**.

- [ ] **Step 5: Record the result**

Write what was verified, with the instance version id, into `otari-brain/projects/demo-locker/demo-locker.md`. Note anything that behaved differently from this plan — that is the material worth keeping.

---

## Self-Review

**Spec coverage.** Every section maps to tasks: the three columns and invite table (1), the resolver (2), all 14 call sites (3, 4, 5), the delete rule (6), invites and invite-gated signup (7, 8), rename (9), the SharePanel fix (10), the collaborator UI (11), live verification (12). The spec's "explicitly out of scope" items — per-playlist collaborator permissions, ownership transfer, invite chaining — are absent by design, and invite chaining is actively tested against in Task 7.

**Type consistency.** `lockerIdOf` / `isLockerOwner` are named identically everywhere. `User` gains `lockerOwnerId: string | null` in both `packages/api/src/types.ts` (Task 2) and `packages/web/src/lib/api.ts` (Task 11). Column names are `locker_owner_id`, `uploaded_by`, `created_by` in SQL and `lockerOwnerId`, `uploadedBy`, `createdBy` in TS throughout.

**Known softness, deliberate.** Tasks 11's Steps 4 and 6 describe the two React components in requirements rather than full source. They are conventional CRUD panels whose exact markup should follow the existing access panel in `Home.tsx`, and pinning that markup here would be guessing at code the implementer can read. Every behaviour that matters is pinned by the tests in Step 1 and by the explicit requirement list. Everything security-relevant — the guards, the gates, the redemption path — is given as literal code.
