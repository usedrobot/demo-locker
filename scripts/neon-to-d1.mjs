// scripts/neon-to-d1.mjs
// One-time Neon -> D1 export. Usage:
//   npm i --no-save postgres
//   node scripts/neon-to-d1.mjs > ~/dl-cutover-dump.sql
// Reads DATABASE_URL from packages/api/.dev.vars. Row counts go to stderr.
//
// The dump contains password hashes and live session tokens. Write it OUTSIDE
// the repo (see docs/superpowers/plans/2026-07-24-cutover-runbook.md) and
// delete it once the cutover is verified. `dump.sql` is gitignored as a
// belt-and-braces guard, but the runbook path is the one to use.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const vars = readFileSync("packages/api/.dev.vars", "utf-8");
const url = vars.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
if (!url) {
  console.error("DATABASE_URL not found in packages/api/.dev.vars");
  process.exit(1);
}
// The old Postgres columns are `timestamp` WITHOUT time zone (OID 1114) and
// were always written/read as UTC by drizzle's pg driver (which appends
// "+0000" before parsing). postgres.js instead hands the raw
// "2026-07-27 14:00:00.123" string to `new Date(...)`, which V8 interprets as
// LOCAL time — silently shifting every timestamp by the exporting machine's
// UTC offset. Override the date parser so a naive string is read as UTC, and
// leave already-offset-bearing strings (timestamptz, OID 1184) alone.
const parseAsUtc = (x) =>
  new Date(/[Zz]|[+-]\d\d(:?\d\d)?$/.test(x) ? x : x + "Z");

const sql = postgres(url, {
  types: {
    date: {
      to: 1184,
      from: [1082, 1114, 1184],
      serialize: (x) => x,
      parse: parseAsUtc,
    },
  },
});

// FK dependency order — parents first.
const TABLES = ["users", "sessions", "playlists", "tracks", "comments", "shares"];

function lit(v) {
  if (v === null || v === undefined) return "NULL";
  // schema.ts uses { mode: "timestamp_ms" } — epoch MILLISECONDS, not seconds.
  if (v instanceof Date) return String(v.getTime());
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  return `'${String(v).replaceAll("'", "''")}'`;
}

for (const table of TABLES) {
  const rows = await sql`select * from ${sql(table)}`;
  console.error(`${table}: ${rows.length} rows`);
  for (const row of rows) {
    const cols = Object.keys(row);
    // OR REPLACE so a partially-applied import can simply be rerun: D1's HTTP
    // API gives no client-side transaction across a batch, so a network blip
    // mid-import leaves rows behind. Rerunning is then idempotent.
    console.log(
      `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols
        .map((c) => lit(row[c]))
        .join(", ")});`,
    );
  }
}
await sql.end();
