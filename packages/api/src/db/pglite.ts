// Embedded Postgres (PGlite) for zero-dependency self-hosting.
// Same Postgres dialect as Neon/postgres-js — one schema, one migration set.

import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.js";
import type { Database } from "./index.js";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

export async function createPgliteDb(dataDir?: string): Promise<Database> {
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return db;
}
