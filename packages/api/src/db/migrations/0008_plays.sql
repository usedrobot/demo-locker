CREATE TABLE `plays` (
	`id` text PRIMARY KEY NOT NULL,
	`track_id` text NOT NULL,
	`playlist_id` text,
	`played_at` integer NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `plays_track_idx` ON `plays` (`track_id`);--> statement-breakpoint
CREATE INDEX `plays_playlist_idx` ON `plays` (`playlist_id`);