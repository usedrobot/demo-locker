import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { users, sessions } from "../db/schema.js";
import { hashPassword, verifyPassword, generateToken } from "../lib/auth.js";
import { requireAuth } from "../lib/session.js";
import type { Env } from "../types.js";

const auth = new Hono<Env>();

auth.post("/signup", async (c) => {
  const { email, password } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: "email and password required" }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: "password must be at least 8 characters" }, 400);
  }

  const db = getDb(c.env.DATABASE_URL);

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    return c.json({ error: "email already registered" }, 409);
  }

  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash })
    .returning({ id: users.id, email: users.email });

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await db.insert(sessions).values({ userId: user.id, token, expiresAt });

  return c.json({ user, token }, 201);
});

auth.post("/login", async (c) => {
  const { email, password } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: "email and password required" }, 400);
  }

  const db = getDb(c.env.DATABASE_URL);

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await db.insert(sessions).values({ userId: user.id, token, expiresAt });

  return c.json({
    user: { id: user.id, email: user.email },
    token,
  });
});

auth.get("/me", requireAuth, async (c) => {
  return c.json({ user: c.get("user") });
});

auth.post("/logout", requireAuth, async (c) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (token) {
    const db = getDb(c.env.DATABASE_URL);
    await db.delete(sessions).where(eq(sessions.token, token));
  }
  return c.json({ ok: true });
});

export default auth;
