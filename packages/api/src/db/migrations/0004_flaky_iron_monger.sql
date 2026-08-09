-- HAND-PATCHED, same trap as 0003: drizzle-kit 0.31.10 drops FK actions
-- (ON DELETE ...) from `ALTER TABLE ... ADD COLUMN` on SQLite while still
-- recording them in meta/0004_snapshot.json. It generated
--   ALTER TABLE `shares` ADD `created_by` text REFERENCES users(id)
-- (the trailing semicolon is left off this quoted line deliberately: it sits in
-- the same pre-breakpoint chunk as the real statement below, and a splitter
-- that is not comment-aware would cut the file here)
-- and the ` ON DELETE CASCADE` below was added by hand to match what the
-- snapshot already claims is true. Do not regenerate this migration — that
-- would silently drop the patch, and the whole guarantee (a collaborator's
-- share links die with them) lives in that clause.
ALTER TABLE `shares` ADD `created_by` text REFERENCES users(id) ON DELETE CASCADE;--> statement-breakpoint
-- BACKFILL — a deliberate, documented exception to this plan's "no backfill"
-- rule. Leaving NULL would make the column mean two things at once: "minted by
-- the owner before this column existed" and "minted by a collaborator during
-- the window between the collaborator-minting change and this migration". The
-- cascade cannot act on the second, and nothing could tell them apart.
--
-- The value is knowable for one reason only: no collaborator account can
-- exist yet. Redemption is not implemented at this commit, and nothing
-- anywhere writes users.locker_owner_id — every reference to it is a read.
-- So on any real instance running this migration, every share was necessarily
-- minted by an owner, and the owner is the playlist's owner_id.
--
-- Note the reason is NOT "POST /shares was owner-only" — it is already
-- locker-scoped at this commit, so a collaborator session could mint if one
-- existed. Where a collaborator's link did get backfilled to the playlist
-- owner, this UPDATE would hand it permanent life: the cascade would no
-- longer reach it when that collaborator is removed, which is precisely the
-- hole the column exists to close. The one way to reach that today is a
-- hand-provisioned locker_owner_id row, written directly into the database
-- by an operator; that case, and only that case, this backfill gets wrong.
--
-- One row per share, non-destructive.
UPDATE shares
SET created_by = (SELECT owner_id FROM playlists WHERE playlists.id = shares.playlist_id)
WHERE created_by IS NULL;
