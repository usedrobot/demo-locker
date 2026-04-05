import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { sessions, users } from "../db/schema.js";
import type { Env } from "../types.js";

export const requireAuth = createMiddleware<Env>(async (c, next) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return c.json({ error: "unauthorized" }, 401);

  const db = getDb(c.env.DATABASE_URL);

  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.token, token))
    .limit(1);

  if (!session || session.expiresAt < new Date()) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user) return c.json({ error: "unauthorized" }, 401);

  c.set("user", user);
  return next();
});
