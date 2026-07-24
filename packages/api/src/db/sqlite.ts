// Embedded SQLite (better-sqlite3) for zero-dependency self-hosting.
// Same dialect as D1 — one schema, one migration set.

import { fileURLToPath } from "node:url";
import DatabaseConstructor from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import type { Database } from "./index.js";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

export function createSqliteDb(dbPath?: string): Database {
  const client = new DatabaseConstructor(dbPath ?? ":memory:");
  client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = ON");
  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder });
  return db;
}
