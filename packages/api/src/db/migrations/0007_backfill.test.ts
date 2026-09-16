// Migration 0007 moves playlist membership off tracks.playlist_id and onto a
// join table. A track in a playlist must come out the other side as exactly
// one join row carrying its old position; a library track must produce none;
// and nothing else — above all no comment — may be lost on the way.
//
// Two runs of the same file. The first goes through the REAL Node runner
// (runMigrations in ../sqlite.ts). The second applies the SQL raw inside a
// single BEGIN/COMMIT with foreign keys ON, which is how wrangler applies it
// to D1 and where no runner can intervene. The comment seeded on a track is
// the canary: the migration as drizzle-kit first generated it (a table
// recreate) deleted it on both paths.
import { describe, it, expect } from "vitest";
import DatabaseConstructor from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runMigrations } from "../sqlite.js";

const dir = dirname(fileURLToPath(import.meta.url));

type Journal = { entries: { idx: number; when: number; tag: string }[] };

function apply(db: DatabaseConstructor.Database, file: string) {
  const sql = readFileSync(join(dir, file), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    if (stmt.trim()) db.exec(stmt);
  }
}

// Bring an empty database to the state a real instance is in before 0007:
// migrations 0000–0006 applied and recorded, so the runner applies only what
// comes after.
function databaseAt0006(): DatabaseConstructor.Database {
  const db = new DatabaseConstructor(":memory:");
  db.pragma("foreign_keys = ON");
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as Journal;
  const upTo0006 = journal.entries.filter((e) => e.idx <= 6);
  expect(upTo0006).toHaveLength(7);
  for (const e of upTo0006) apply(db, `${e.tag}.sql`);
  db.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
  const last = upTo0006[upTo0006.length - 1];
  db.prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`).run("seeded", last.when);
  return db;
}

function seed(db: DatabaseConstructor.Database) {
  db.exec(`INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'o@test.dev', 'x', 0)`);
  db.exec(`INSERT INTO playlists (id, owner_id, name, is_public, created_at, updated_at) VALUES ('p1', 'u1', 'one', 0, 0, 0)`);
  db.exec(`INSERT INTO tracks (id, playlist_id, owner_id, title, position, original_key, uploaded_at) VALUES
    ('t1', 'p1', 'u1', 'first', 0, 'k1', 1000),
    ('t2', 'p1', 'u1', 'second', 1, 'k2', 2000),
    ('t3', NULL, 'u1', 'library', 0, 'k3', 3000)`);
  db.exec(`INSERT INTO comments (id, track_id, author_name, body, created_at) VALUES ('c1', 't1', 'DL', 'chorus late', 0)`);
}

function expectMigrated(db: DatabaseConstructor.Database) {
  const rows = db
    .prepare(`SELECT playlist_id, track_id, position, added_at FROM playlist_tracks ORDER BY position`)
    .all() as { playlist_id: string; track_id: string; position: number; added_at: number }[];
  expect(rows).toEqual([
    { playlist_id: "p1", track_id: "t1", position: 0, added_at: 1000 },
    { playlist_id: "p1", track_id: "t2", position: 1, added_at: 2000 },
  ]);

  const cols = (db.prepare(`PRAGMA table_info(tracks)`).all() as { name: string }[]).map((c) => c.name);
  expect(cols).not.toContain("playlist_id");
  expect(cols).not.toContain("position");
  // Every track survived the column drops, and so did the comment on one of them.
  expect(db.prepare(`SELECT count(*) AS n FROM tracks`).get()).toEqual({ n: 3 });
  expect(db.prepare(`SELECT count(*) AS n FROM comments`).get()).toEqual({ n: 1 });
  // Foreign keys are enforced again afterwards, and nothing dangles.
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(db.pragma("foreign_key_check")).toEqual([]);
  // The child tables still point at tracks: a cascade works.
  db.exec(`DELETE FROM tracks WHERE id = 't1'`);
  expect(db.prepare(`SELECT count(*) AS n FROM playlist_tracks`).get()).toEqual({ n: 1 });
  expect(db.prepare(`SELECT count(*) AS n FROM comments`).get()).toEqual({ n: 0 });
}

describe("0007 backfill", () => {
  it("through the Node runner: memberships and positions copied, comments kept, library track untouched", () => {
    const db = databaseAt0006();
    seed(db);
    runMigrations(db);
    expectMigrated(db);
  });

  it("raw inside one transaction with foreign keys on, the way D1 applies it: same result", () => {
    const db = databaseAt0006();
    seed(db);
    db.exec("BEGIN");
    apply(db, "0007_playlist_tracks.sql");
    db.exec("COMMIT");
    expectMigrated(db);
  });
});
