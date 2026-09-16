// Embedded SQLite (better-sqlite3) for zero-dependency self-hosting.
// Same dialect as D1 — one schema, one migration set.

import { fileURLToPath } from "node:url";
import DatabaseConstructor from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import type { Database } from "./index.js";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

// Apply every pending migration to an open client.
//
// Foreign keys stay ON throughout, deliberately. drizzle's migrator wraps
// every pending file in one BEGIN/COMMIT, and SQLite ignores `PRAGMA
// foreign_keys` inside a transaction, so the OFF/ON pair drizzle-kit writes
// around a generated table recreate does nothing — and wrangler applies the
// same file to D1 under the same rule. Turning enforcement off here would make
// this runner the one place a migration behaves differently: a green Node
// suite over a recreate that cascades and destroys data on every Cloudflare
// instance. Migration 0007 measured exactly that loss and was hand-patched to
// carry the affected rows across the recreate instead (see its header and
// 0007_backfill.test.ts). The check afterwards catches anything a migration
// left dangling.
export function runMigrations(client: DatabaseConstructor.Database): void {
  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder });
  const violations = client.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error(`migrations left ${violations.length} dangling foreign key reference(s)`);
  }
}

export function createSqliteDb(dbPath?: string): Database {
  const client = new DatabaseConstructor(dbPath ?? ":memory:");
  client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = ON");
  runMigrations(client);
  return drizzle(client, { schema });
}
