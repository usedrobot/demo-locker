import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { generateId } from "../lib/ids.js";

const now = () => new Date();

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(generateId),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey().$defaultFn(generateId),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});

export const playlists = sqliteTable("playlists", {
  id: text("id").primaryKey().$defaultFn(generateId),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  artworkKey: text("artwork_key"),
  isPublic: integer("is_public", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
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
  uploadedAt: integer("uploaded_at", { mode: "timestamp" }).notNull().$defaultFn(now),
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
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
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
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
});
