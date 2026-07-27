# Hosted cutover: Neon -> D1 (DL present, ~minutes of downtime)

Preconditions: port branch reviewed and ready to merge; Tasks 1-7 green in CI on the branch; D1 db exists with binding in wrangler.jsonc; `packages/api/.dev.vars` holds the Neon DATABASE_URL.

**Dump file location.** The export contains password hashes and live session
tokens. Always write it **outside the repo** — this runbook uses
`~/dl-cutover-dump.sql` throughout. (`dump.sql` is also gitignored, but do not
rely on that.)

**Timestamp units.** All timestamp columns are `{ mode: "timestamp_ms" }` —
epoch **milliseconds**. Every `datetime(...)` check below therefore divides by
1000. If you see dates in 1970, something emitted seconds.

---

## Phase 0 — rehearsal (do this BEFORE the freeze; touches nothing remote)

R1. From repo root: `npm i --no-save postgres && node scripts/neon-to-d1.mjs > ~/dl-cutover-dump.sql`
    - stderr prints per-table Neon counts. **Record them** — they are the
      reference for every check below.

R2. `cd packages/api && npx wrangler d1 migrations apply demo-locker-db --local`

R3. `npx wrangler d1 execute demo-locker-db --local --file ~/dl-cutover-dump.sql`

R4. Local count diff — must equal the R1 stderr counts, all six tables:
```sh
for t in users sessions playlists tracks comments shares; do
  echo -n "$t: "
  npx wrangler d1 execute demo-locker-db --local --json \
    --command "select count(*) as n from $t"
done
```

R5. Local **value** spot-check (counts alone cannot detect value corruption —
    a timezone-shifted or unit-shifted timestamp keeps every count identical).
    Run both and confirm they match **to the second**:
```sh
# Neon (psql against $DATABASE_URL)
select created_at from users order by created_at limit 1;

# D1 local
npx wrangler d1 execute demo-locker-db --local \
  --command "select datetime(created_at/1000,'unixepoch') from users order by created_at limit 1"
```
    Repeat for at least one more table with a user-visible time, e.g.
    `tracks.uploaded_at` and `shares.expires_at`.
    A mismatch of a whole number of hours means the export ran with a broken
    date parser — **stop**, do not proceed to the remote import.

R6. Only when R4 and R5 both pass, continue to the live cutover.

---

## Phase 1 — live cutover

1. Announce freeze (nobody uploads/comments during the window).
2. `cd packages/api && npx wrangler d1 migrations apply demo-locker-db --remote`
3. From repo root, re-export against live Neon (the rehearsal dump is stale by
   however long Phase 0 took):
   `node scripts/neon-to-d1.mjs > ~/dl-cutover-dump.sql`
   - stderr shows per-table Neon counts. Record them.
4. `cd packages/api && npx wrangler d1 execute demo-locker-db --remote --file ~/dl-cutover-dump.sql`
5. Verify counts, each table:
   `npx wrangler d1 execute demo-locker-db --remote --json --command "select count(*) as n from users"`
   (repeat for sessions, playlists, tracks, comments, shares — must match step 3.)
6. Verify **values**, same spot-check as R5 but `--remote`:
```sh
npx wrangler d1 execute demo-locker-db --remote \
  --command "select datetime(created_at/1000,'unixepoch') from users order by created_at limit 1"
```
   Must match the Neon `select created_at from users order by created_at limit 1`
   to the second. Also spot-check `tracks.uploaded_at` and `shares.expires_at`.
7. Merge the PR -> CI deploys the D1-backed Worker + web.
8. Live verification: login, playback, waveform comments, listen + edit share links, /embed.js player on a public playlist.
9. Delete the dump: `rm ~/dl-cutover-dump.sql` (contains password hashes + session tokens).
10. Rollback window: leave Neon untouched for 7 days. Rollback = `git revert` the merge and redeploy (old Worker still speaks Neon). After 7 days with no issues: delete the Neon project and the DATABASE_URL Worker secret (`npx wrangler secret delete DATABASE_URL`), and delete `.dev.vars`.

---

## Recovery — the import failed partway through (step 4 or R3)

D1's HTTP API has **no client-side transaction across a batch**, so a network
blip mid-`tracks` leaves the database half-populated. The dump emits
`INSERT OR REPLACE INTO`, so the simplest recovery is: **wipe the app tables and
rerun step 4 from the same dump file.** Do not hand-patch.

From `packages/api` (swap `--remote` for `--local` when recovering a rehearsal):

```sh
npx wrangler d1 execute demo-locker-db --remote --command \
  "delete from comments; delete from shares; delete from tracks; delete from sessions; delete from playlists; delete from users;"
```

Reverse-FK order — children before parents — so foreign keys never block a
delete. Then confirm the tables are empty:

```sh
npx wrangler d1 execute demo-locker-db --remote --json --command \
  "select (select count(*) from users) u, (select count(*) from sessions) s, (select count(*) from playlists) p, (select count(*) from tracks) t, (select count(*) from comments) c, (select count(*) from shares) sh"
```

All six must be 0. Then rerun step 4, then steps 5 and 6.

Note this deletes only application rows — the schema and the `d1_migrations`
bookkeeping table are untouched, so there is no need to re-run step 2.
