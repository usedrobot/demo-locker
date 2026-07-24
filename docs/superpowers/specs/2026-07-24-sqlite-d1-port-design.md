# SQLite/D1 Port — Design

**Date:** 2026-07-24
**Status:** Approved by DL (conversation, 2026-07-24)

## Goal

Replace Postgres (Neon on the hosted Worker, PGlite on self-hosted Node) with SQLite everywhere: Cloudflare D1 on the Workers path, a plain SQLite file on the Node/Docker path. This makes "deploy your own to Cloudflare" a single-vendor story (no Neon signup), makes self-host backup "copy one folder," and retires the manual-Neon-migration workflow.

This is a **clean break**: Postgres support is deleted, not kept alongside. The project is early enough that external Postgres self-hosters are assumed to be zero; anyone affected can file an issue.

## Decisions (made with DL 2026-07-24)

1. **Clean break** — delete pg-core schema, Neon driver, PGlite, and pg migrations. No dual-dialect, no pg→sqlite export escape hatch.
2. **Hosted data migrates** — one-time Neon → D1 export/import; users, playlists, comments, and share links survive. R2 audio and keys untouched.
3. **Fly/Railway wizard targets will be dropped** — decided now, executed in the follow-up wizard spec (spec 2), not here. This port doesn't touch the CLI.

## Out of scope (spec 2: wizard Cloudflare target)

- `cloudflare` deploy target in `npx demo-locker` (wrangler login, D1 create, R2 create, deploy Worker + Pages).
- Removing Fly/Railway targets.
- Post-deploy "expose it" step for the Docker path (cloudflared/Caddy/LAN).
- DL's VPS instance gets no migration — it will be deprecated and rebuilt via the new wizard as spec 2's live test.

## Schema

Rewrite `packages/api/src/db/schema.ts` in `drizzle-orm/sqlite-core`. Same six tables (users, sessions, playlists, tracks, comments, shares), same columns, same FK cascade rules (`cascade` / `set null`), same unique constraints, same `permission` text enum.

Type mapping:

| Postgres (today) | SQLite (new) |
|---|---|
| `uuid` + `defaultRandom()` | `text` + `$defaultFn(() => generateId())` — app-side ID generation via a `lib/ids.ts`-style helper in the API package (mirror of the web package's secure-context-safe helper) |
| `timestamp` + `defaultNow()` | `integer({ mode: "timestamp" })` + `$defaultFn` — route code continues to receive `Date` objects |
| `boolean` | `integer({ mode: "boolean" })` |
| `real`, `integer`, `text` | unchanged |

Existing UUID values in prod data are plain text after migration. `generateId()` MUST return UUID-format strings so new and migrated IDs are indistinguishable in URLs, tests, and any format-sensitive code.

## DB layer

Mirrors the current two-file split:

- **`db/index.ts` (Workers):** `drizzle-orm/d1` over a `DB` D1 binding declared in `wrangler.jsonc`. Replaces `drizzle-orm/neon-http` + `@neondatabase/serverless` + the `DATABASE_URL` Worker secret. `getDb` signature changes from `(url: string)` to taking the binding; update the env-injection call sites (`server.ts` passes bindings via `app.fetch(request, bindings)` — the pattern from the 2026-07-06 middleware fix).
- **`db/sqlite.ts` (Node/Docker):** replaces `db/pglite.ts`. SQLite file lives in the data volume (e.g. `/data/demolocker.db`) next to the audio; runs migrations at boot exactly as PGlite does today.
- **Node driver:** better-sqlite3, **unless** planning-time verification shows Drizzle's `node:sqlite` support is production-solid — zero native deps would simplify the multi-arch Docker build (see the QEMU lesson: native modules must compile cleanly on both `ubuntu-latest` and `ubuntu-24.04-arm` runners). The plan must include this verification step and pick one.

**Transactions:** the API uses none (verified by grep 2026-07-24), so D1's batch-only transaction model imposes no changes. New code must not introduce interactive transactions without a D1-compatible design.

## Migrations

- Delete pg migrations 0000–0003; `drizzle-kit generate` produces a fresh SQLite `0000` from the new schema. (Fresh installs were the only consumers of the full pg chain; prod Neon is being retired.)
- **Hosted:** CI applies `wrangler d1 migrations apply` (remote) before the Worker deploy step in `ci.yml`. This retires the standing "apply additive ALTERs to prod Neon before merging" rule — update CLAUDE.md/vault notes at completion.
- **Self-host:** migrations applied automatically at boot (unchanged behavior).

## Prod cutover (gated step — DL present)

1. Create the D1 database, add the binding to `wrangler.jsonc`, apply migrations.
2. Run a one-time export/import script: read all rows from Neon (via the `.dev.vars` + node postgres procedure), insert into D1 (`wrangler d1 execute` or the API's driver). Row counts verified per table. R2 keys are copied verbatim — audio is untouched.
3. Deploy the D1-backed Worker.
4. Verify live: login, playback, comments, share links (listen + edit), embed player.
5. **Rollback window:** Neon is frozen (no writes reach it after cutover) and kept for one week; rollback = redeploy the last Neon-backed Worker. After the window, delete the Neon project and the `DATABASE_URL` secret.

Brief downtime (minutes) is acceptable; the dataset is tiny.

## Tests / CI

- The API test suite (32 tests) moves from PGlite to in-memory SQLite (better-sqlite3 `:memory:` or equivalent).
- Smoke test assertions unchanged; its Docker boot path now exercises the SQLite file.
- Dependencies deleted: `@neondatabase/serverless`, `@electric-sql/pglite`.
- Docs updated: `self-hosting.md` (no Postgres section; SQLite file location + backup note), README stack table, AGENTS.md runbook, llms.txt if it mentions Postgres.

## Success criteria

- All API tests green on in-memory SQLite; smoke test green on the Docker path.
- Hosted instance serves existing users/playlists/comments/share links from D1 with no data loss (per-table row counts match).
- `DATABASE_URL` secret and Neon project deleted after the rollback window.
- No `drizzle-orm/pg-core` imports remain in the repo.
