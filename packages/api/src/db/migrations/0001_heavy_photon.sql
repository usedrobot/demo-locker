ALTER TABLE "comments" ADD COLUMN "resolved_at" timestamp;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "delete_token" text;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;