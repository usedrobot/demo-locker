import { sqliteTable, text, integer, real, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { generateId } from "../lib/ids.js";

const now = () => new Date();

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(generateId),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  // Owner's accent colour, one of ACCENTS in lib/accent.ts. Nullable = never
  // set, so the client falls back to the default. It lives on the user rather
  // than the browser because listeners on a share link should see the owner's
  // colour, and it travels with the invite response.
  accent: text("accent"),
  // The name shown next to this person's uploads and playlists. Copied from
  // collaboratorInvites.label at redemption — the human name the owner typed
  // when minting the invite — rather than joined from that row at read time:
  // DELETE /collab/invites/:id is not restricted to pending invites, so an
  // owner deleting an accepted invite would otherwise erase an active
  // collaborator's name. Nullable with no default and no backfill: the owner
  // has no invite and therefore no label, and anyone who redeemed before this
  // column existed keeps NULL. Both fall back to their email address.
  displayName: text("display_name"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  // Null = this account owns a locker. Set = this account is a collaborator on
  // the referenced owner's locker, sharing that library rather than having one
  // of its own. Self-referential, so it is declared with an explicit callback.
  lockerOwnerId: text("locker_owner_id").references((): AnySQLiteColumn => users.id, {
    onDelete: "cascade",
  }),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey().$defaultFn(generateId),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

export const playlists = sqliteTable("playlists", {
  id: text("id").primaryKey().$defaultFn(generateId),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  artworkKey: text("artwork_key"),
  isPublic: integer("is_public", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  // Who created this playlist. Null on rows predating collaboration, and on
  // rows whose creator has since been removed — both read as the owner.
  createdBy: text("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
});

export const tracks = sqliteTable("tracks", {
  id: text("id").primaryKey().$defaultFn(generateId),
  // Tracks are library items owned by a user; playlist membership is optional.
  // Deleting a playlist detaches its tracks (SET NULL) instead of deleting them.
  playlistId: text("playlist_id").references(() => playlists.id, {
    onDelete: "set null",
  }),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  position: integer("position").notNull(),
  originalKey: text("original_key").notNull(),
  streamKey: text("stream_key"),
  waveformData: text("waveform_data"),
  duration: real("duration"),
  // Original + rendition bytes. Recorded so MAX_STORAGE_BYTES can actually be
  // enforced — it was documented and read from the env for four releases while
  // having no call site at all. Null on rows uploaded before this column, which
  // the accounting treats as 0 rather than guessing.
  sizeBytes: integer("size_bytes"),
  uploadedAt: integer("uploaded_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  // Who uploaded this file. `ownerId` says which locker it belongs to; this
  // says whose demo it is. SET NULL rather than cascade: removing a person
  // must never remove their music from the owner's library.
  uploadedBy: text("uploaded_by").references(() => users.id, {
    onDelete: "set null",
  }),
});

// Fixed-window counters for the auth routes. A table rather than a Workers
// rate-limit binding because the same code runs on Node self-hosts, where no
// such binding exists — and unauthenticated login was previously unmetered,
// which made both password guessing and PBKDF2 CPU burn free.
export const rateLimits = sqliteTable("rate_limits", {
  // "<route>:<client ip>" — see lib/rate-limit.ts
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: integer("window_start", { mode: "timestamp_ms" }).notNull(),
});

export const comments = sqliteTable("comments", {
  id: text("id").primaryKey().$defaultFn(generateId),
  trackId: text("track_id").references(() => tracks.id, {
    onDelete: "cascade",
  }),
  playlistId: text("playlist_id").references(() => playlists.id, {
    onDelete: "cascade",
  }),
  parentId: text("parent_id"),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  timestampSec: real("timestamp_sec"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  resolvedBy: text("resolved_by").references(() => users.id),
  deleteToken: text("delete_token"),
});

export const shares = sqliteTable("shares", {
  id: text("id").primaryKey().$defaultFn(generateId),
  playlistId: text("playlist_id")
    .notNull()
    .references(() => playlists.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  permission: text("permission", { enum: ["listen", "edit"] }).notNull(),
  email: text("email"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  // Who minted this link. CASCADE, not SET NULL: nothing ever sets expiresAt,
  // so a link outlives its minter forever — and a listen link can download the
  // lossless master. Removing a collaborator must remove every grant they
  // handed out, edit and listen alike. Enforced by the database rather than by
  // a purge in the revoke handler so it holds on every deletion path,
  // including ones nobody has written yet. Migration 0004 backfills existing
  // rows with their playlist's owner (provably correct: before this branch,
  // only the owner could mint), so NULL is not a state that occurs.
  createdBy: text("created_by").references(() => users.id, { onDelete: "cascade" }),
});

// A one-shot invitation to join someone's locker as a collaborator. Signup is
// closed on every instance once an owner exists (lib/signup.ts); a valid,
// unredeemed invite is the only thing that opens it, and only for one account.
export const collaboratorInvites = sqliteTable("collaborator_invites", {
  id: text("id").primaryKey().$defaultFn(generateId),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  // Shown in the owner's access list so a pending invite is identifiable
  // before it is redeemed. Not an email — nothing is sent.
  label: text("label").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  acceptedBy: text("accepted_by").references(() => users.id, {
    onDelete: "set null",
  }),
  acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
});
