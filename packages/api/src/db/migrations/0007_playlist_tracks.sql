-- HAND-PATCHED (the 0003/0004 convention). drizzle-kit 0.31.10 generated the
-- two column drops as a table recreate — CREATE __new_tracks, copy, DROP
-- TABLE tracks, RENAME — wrapped in `PRAGMA foreign_keys=OFF/ON`. That pragma
-- is a no-op inside a transaction, and both migrators run this file in one
-- (drizzle's for SQLite self-hosts, wrangler's for D1). With enforcement on,
-- DROP TABLE performs an implicit DELETE that cascades into every child of
-- tracks: measured on both runners, it erased every track comment and the
-- join rows this file had just written. Plain DROP COLUMN is not available
-- either: 0000_init declares tracks.playlist_id's foreign key as a table-level
-- clause, which survives the column drop and then names a missing column
-- (measured: "unknown column playlist_id in foreign key definition").
--
-- So the recreate stays, and the rows the cascade would take are carried
-- across it in plain scratch tables (no foreign keys, so nothing cascades
-- into them) and put back once the new tracks table exists. INSERT OR IGNORE
-- makes the restore a no-op on any runner where the cascade did not fire.
-- The only children of tracks are comments.track_id and playlist_tracks
-- (created here); the backfill is deferred until after the recreate for the
-- same reason.
--
-- Do not regenerate this migration — that would bring the bare recreate
-- back. meta/0007_snapshot.json already describes the resulting schema.
-- 0007_backfill.test.ts applies this file through the Node runner and raw
-- inside BEGIN/COMMIT with foreign keys on, the way D1 does.
CREATE TABLE `playlist_tracks` (
	`playlist_id` text NOT NULL,
	`track_id` text NOT NULL,
	`position` integer NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`playlist_id`, `track_id`),
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playlist_tracks_track_idx` ON `playlist_tracks` (`track_id`);--> statement-breakpoint
-- Carry-over 1: playlist membership, read off the columns about to be dropped.
CREATE TABLE `__migr_0007_membership` AS
SELECT `playlist_id`, `id` AS `track_id`, `position`, `uploaded_at` AS `added_at`
FROM `tracks` WHERE `playlist_id` IS NOT NULL;--> statement-breakpoint
-- Carry-over 2: every comment on a track. Playlist-level comments have no
-- track_id and are not touched by the cascade.
CREATE TABLE `__migr_0007_comments` AS SELECT * FROM `comments` WHERE `track_id` IS NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`original_key` text NOT NULL,
	`stream_key` text,
	`waveform_data` text,
	`duration` real,
	`size_bytes` integer,
	`uploaded_at` integer NOT NULL,
	`uploaded_by` text,
	`uploaded_by_name` text,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_tracks`("id", "owner_id", "title", "original_key", "stream_key", "waveform_data", "duration", "size_bytes", "uploaded_at", "uploaded_by", "uploaded_by_name") SELECT "id", "owner_id", "title", "original_key", "stream_key", "waveform_data", "duration", "size_bytes", "uploaded_at", "uploaded_by", "uploaded_by_name" FROM `tracks`;--> statement-breakpoint
DROP TABLE `tracks`;--> statement-breakpoint
ALTER TABLE `__new_tracks` RENAME TO `tracks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- Restore what the cascade took (or nothing, where it did not fire).
INSERT OR IGNORE INTO `comments` SELECT * FROM `__migr_0007_comments`;--> statement-breakpoint
DROP TABLE `__migr_0007_comments`;--> statement-breakpoint
-- BACKFILL: every track that had a playlist becomes one join row, keeping its
-- position and dating the membership from the upload.
INSERT INTO `playlist_tracks` (`playlist_id`, `track_id`, `position`, `added_at`)
SELECT `playlist_id`, `track_id`, `position`, `added_at` FROM `__migr_0007_membership`;--> statement-breakpoint
DROP TABLE `__migr_0007_membership`;
