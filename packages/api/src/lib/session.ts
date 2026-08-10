import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "../db/index.js";
import { sessions, users } from "../db/schema.js";
import { hashToken } from "./auth.js";
import type { Env } from "../types.js";

// Every session lookup goes through here. Tokens are stored as SHA-256 digests
// (see hashToken), so the raw token a client presents has to be hashed before
// it can be matched — doing that in one place is what keeps the six call sites
// that used to run `eq(sessions.token, raw)` from silently failing open or
// closed as this changed.
//
// Rows written before hashing existed hold the raw token. Those are matched on
// the fallback path and upgraded in place, so nobody is signed out by the
// upgrade; the fallback becomes dead weight once every live session has rotated
// and can be deleted after a release or two.
export async function findSession(db: Database, rawToken: string) {
  const hashed = await hashToken(rawToken);

  const [byHash] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.token, hashed))
    .limit(1);
  if (byHash) return byHash;

  const [legacy] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.token, rawToken))
    .limit(1);
  if (!legacy) return null;

  await db
    .update(sessions)
    .set({ token: hashed })
    .where(eq(sessions.id, legacy.id));
  return { ...legacy, token: hashed };
}

export async function createSession(
  db: Database,
  userId: string,
  rawToken: string,
  expiresAt: Date
): Promise<void> {
  await db
    .insert(sessions)
    .values({ userId, token: await hashToken(rawToken), expiresAt });
}

export async function deleteSession(db: Database, rawToken: string): Promise<void> {
  const session = await findSession(db, rawToken);
  if (session) {
    await db.delete(sessions).where(eq(sessions.id, session.id));
  }
}

// Pull the presented credential off a request: Bearer header, or the `?token=`
// query param that media elements have to use because they cannot set headers.
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const value = header.replace("Bearer ", "").trim();
  return value || null;
}

export const requireAuth = createMiddleware<Env>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) return c.json({ error: "unauthorized" }, 401);

  const db = getDb(c.env.DB);

  const session = await findSession(db, token);
  if (!session || session.expiresAt < new Date()) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      accent: users.accent,
      displayName: users.displayName,
      lockerOwnerId: users.lockerOwnerId,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user) return c.json({ error: "unauthorized" }, 401);

  c.set("user", user);
  return next();
});
