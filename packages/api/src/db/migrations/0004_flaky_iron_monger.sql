-- HAND-PATCHED, same trap as 0003: drizzle-kit 0.31.10 drops FK actions
-- (ON DELETE ...) from `ALTER TABLE ... ADD COLUMN` on SQLite while still
-- recording them in meta/0004_snapshot.json. It generated
--   ALTER TABLE `shares` ADD `created_by` text REFERENCES users(id);
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
-- The value is knowable and true by construction: before this branch, POST
-- /shares required the owner's own session, so every pre-existing share was
-- minted by its playlist's owner. One row per share, non-destructive.
UPDATE shares
SET created_by = (SELECT owner_id FROM playlists WHERE playlists.id = shares.playlist_id)
WHERE created_by IS NULL;
