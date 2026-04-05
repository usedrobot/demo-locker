import {
  pgTable,
  text,
  timestamp,
  integer,
  real,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const playlists = pgTable("playlists", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  artworkKey: text("artwork_key"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const tracks = pgTable("tracks", {
  id: uuid("id").primaryKey().defaultRandom(),
  playlistId: uuid("playlist_id")
    .notNull()
    .references(() => playlists.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  position: integer("position").notNull(),
  originalKey: text("original_key").notNull(),
  streamKey: text("stream_key"),
  waveformData: text("waveform_data"),
  duration: real("duration"),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
});

export const comments = pgTable("comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  trackId: uuid("track_id").references(() => tracks.id, {
    onDelete: "cascade",
  }),
  playlistId: uuid("playlist_id").references(() => playlists.id, {
    onDelete: "cascade",
  }),
  parentId: uuid("parent_id"),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  timestampSec: real("timestamp_sec"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const shares = pgTable("shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  playlistId: uuid("playlist_id")
    .notNull()
    .references(() => playlists.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  permission: text("permission", { enum: ["listen", "edit"] }).notNull(),
  email: text("email"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
});
