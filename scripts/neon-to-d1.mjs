// scripts/neon-to-d1.mjs
// One-time Neon -> D1 export. Usage:
//   npm i --no-save postgres
//   node scripts/neon-to-d1.mjs > dump.sql
// Reads DATABASE_URL from packages/api/.dev.vars. Row counts go to stderr.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const vars = readFileSync("packages/api/.dev.vars", "utf-8");
const url = vars.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
if (!url) {
  console.error("DATABASE_URL not found in packages/api/.dev.vars");
  process.exit(1);
}
const sql = postgres(url);

// FK dependency order — parents first.
const TABLES = ["users", "sessions", "playlists", "tracks", "comments", "shares"];

function lit(v) {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return String(Math.floor(v.getTime() / 1000)); // epoch seconds
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  return `'${String(v).replaceAll("'", "''")}'`;
}

for (const table of TABLES) {
  const rows = await sql`select * from ${sql(table)}`;
  console.error(`${table}: ${rows.length} rows`);
  for (const row of rows) {
    const cols = Object.keys(row);
    console.log(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols
        .map((c) => lit(row[c]))
        .join(", ")});`,
    );
  }
}
await sql.end();
