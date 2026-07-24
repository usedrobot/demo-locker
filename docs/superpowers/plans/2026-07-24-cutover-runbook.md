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
