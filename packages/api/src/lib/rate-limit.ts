// Fixed-window rate limiting for the unauthenticated auth routes.
//
// Before this, nothing in the API was metered: /auth/login accepted unlimited
// guesses, and because each attempt runs PBKDF2 it also handed an anonymous
// caller a cheap way to burn server CPU. A fixed window (rather than a sliding
// one or a token bucket) is chosen for being one row and one write per attempt
// — the accuracy at a window boundary does not matter for "slow down a
// brute-forcer", and this has to work identically on D1 and on SQLite.

import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { getDb, type Database } from "../db/index.js";
import { rateLimits } from "../db/schema.js";
import type { Env } from "../types.js";

export type RateLimitRule = {
  // Window length in milliseconds.
  windowMs: number;
  // Attempts permitted within a window, per client.
  max: number;
};

// Identify the caller. CF-Connecting-IP is set by Cloudflare and cannot be
// spoofed by the client on that path; X-Forwarded-For is the self-host
// equivalent behind a reverse proxy. Both are absent on a direct Node bind, in
// which case every caller shares the "unknown" bucket — deliberately fail
// closed-ish: a shared bucket throttles harder than no bucket at all.
function clientId(c: Context<Env>): string {
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Forwarded-For")?.split(",")[0].trim() ||
    "unknown"
  );
}

// Returns true when the request is over budget and should be rejected.
export async function isRateLimited(
  db: Database,
  key: string,
  rule: RateLimitRule,
  now: Date = new Date()
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(rateLimits)
    .where(eq(rateLimits.key, key))
    .limit(1);

  const windowExpired =
    !row || now.getTime() - row.windowStart.getTime() >= rule.windowMs;

  if (windowExpired) {
    // Upsert rather than insert: the row may exist with a stale window.
    if (row) {
      await db
        .update(rateLimits)
        .set({ count: 1, windowStart: now })
        .where(eq(rateLimits.key, key));
    } else {
      await db.insert(rateLimits).values({ key, count: 1, windowStart: now });
    }
    return false;
  }

  if (row.count >= rule.max) return true;

  await db
    .update(rateLimits)
    .set({ count: row.count + 1 })
    .where(eq(rateLimits.key, key));
  return false;
}

// Hono middleware factory. `name` scopes the bucket so a login flood cannot
// consume the signup budget or vice versa.
export function rateLimit(name: string, rule: RateLimitRule) {
  return async (c: Context<Env>, next: () => Promise<void>) => {
    const db = getDb(c.env.DB);
    const key = `${name}:${clientId(c)}`;
    if (await isRateLimited(db, key, rule)) {
      c.header("Retry-After", String(Math.ceil(rule.windowMs / 1000)));
      return c.json({ error: "too many requests — try again shortly" }, 429);
    }
    await next();
  };
}

// Tuned to be invisible to a person typing their own password wrong a few
// times, and ruinous for a script.
export const LOGIN_RULE: RateLimitRule = { windowMs: 15 * 60 * 1000, max: 10 };
export const SIGNUP_RULE: RateLimitRule = { windowMs: 60 * 60 * 1000, max: 5 };
