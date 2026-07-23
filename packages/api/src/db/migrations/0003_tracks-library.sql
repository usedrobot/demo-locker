ALTER TABLE "tracks" DROP CONSTRAINT "tracks_playlist_id_playlists_id_fk";
--> statement-breakpoint
ALTER TABLE "tracks" ALTER COLUMN "playlist_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
UPDATE "tracks" SET "owner_id" = "playlists"."owner_id" FROM "playlists" WHERE "tracks"."playlist_id" = "playlists"."id";--> statement-breakpoint
ALTER TABLE "tracks" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE set null ON UPDATE no action;
