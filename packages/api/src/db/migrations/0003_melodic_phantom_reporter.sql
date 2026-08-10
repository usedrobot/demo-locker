-- HAND-PATCHED: drizzle-kit 0.31.10 drops FK actions (ON DELETE ...) from
-- `ALTER TABLE ... ADD COLUMN` statements on SQLite, even though it records
-- the intended action in meta/0003_snapshot.json and applies it correctly
-- for CREATE TABLE. The three ALTER TABLE lines below had their ON DELETE
-- clause added by hand to match what the snapshot already claims is true.
-- Do not regenerate this migration — that would silently drop the patch
-- again. See task-1-report.md for the full trace.
CREATE TABLE `collaborator_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`token` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`accepted_by` text,
	`accepted_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`accepted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaborator_invites_token_unique` ON `collaborator_invites` (`token`);--> statement-breakpoint
ALTER TABLE `playlists` ADD `created_by` text REFERENCES users(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `uploaded_by` text REFERENCES users(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `locker_owner_id` text REFERENCES users(id) ON DELETE CASCADE;