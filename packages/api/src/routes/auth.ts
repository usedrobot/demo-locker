import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { users, sessions } from "../db/schema.js";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  needsRehash,
} from "../lib/auth.js";
import {
  requireAuth,
  bearerToken,
  createSession,
  deleteSession,
  findSession,
} from "../lib/session.js";
import { isValidAccent } from "../lib/accent.js";
import { signupAllowed } from "../lib/signup.js";
import { rateLimit, LOGIN_RULE, SIGNUP_RULE } from "../lib/rate-limit.js";
import type { Env } from "../types.js";

const auth = new Hono<Env>();

auth.post("/signup", rateLimit("signup", SIGNUP_RULE), async (c) => {
  const { email, password } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: "email and password required" }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: "password must be at least 8 characters" }, 400);
  }

  const db = getDb(c.env.DB);

  // Registration closes automatically once the instance has an owner. A Demo
  // Locker is one person's locker — collaborators arrive by share link, not by
  // signing up — but every deployment used to accept registrations from the
  // open internet forever, with no flag to turn it off.
  if (!(await signupAllowed(db, c.env))) {
    return c.json({ error: "registration is closed on this instance" }, 403);
  }

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
    .returning({
      id: users.id,
      email: users.email,
      accent: users.accent,
      lockerOwnerId: users.lockerOwnerId,
    });

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await createSession(db, user.id, token, expiresAt);

  return c.json({ user, token }, 201);
});

auth.post("/login", rateLimit("login", LOGIN_RULE), async (c) => {
  const { email, password } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: "email and password required" }, 400);
  }

  const db = getDb(c.env.DB);

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  // Upgrade the stored hash in place when it predates the current PBKDF2 cost.
  // This is the only moment the plaintext password is available, so it is the
  // only place the migration can happen without a forced reset.
  if (needsRehash(user.passwordHash)) {
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(users.id, user.id));
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await createSession(db, user.id, token, expiresAt);

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      accent: user.accent,
      lockerOwnerId: user.lockerOwnerId,
    },
    token,
  });
});

auth.get("/me", requireAuth, async (c) => {
  return c.json({ user: c.get("user") });
});

// The accent is an account setting, not a browser setting: it is what listeners
// on a share link see, so it has to outlive the owner's localStorage.
auth.post("/accent", requireAuth, async (c) => {
  const { accent } = await c.req.json();

  if (!isValidAccent(accent)) {
    return c.json({ error: "unsupported accent" }, 400);
  }

  const db = getDb(c.env.DB);
  await db.update(users).set({ accent }).where(eq(users.id, c.get("user").id));

  return c.json({ accent });
});

auth.post("/change-password", requireAuth, async (c) => {
  const { currentPassword, newPassword } = await c.req.json();

  if (!currentPassword || !newPassword) {
    return c.json({ error: "currentPassword and newPassword required" }, 400);
  }
  if (newPassword.length < 8) {
    return c.json({ error: "password must be at least 8 characters" }, 400);
  }

  const db = getDb(c.env.DB);
  const sessionUser = c.get("user");

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, sessionUser.id))
    .limit(1);

  // Require the current password even though the caller already holds a valid
  // session: a borrowed or stolen token shouldn't be enough to lock the real
  // owner out of their own locker.
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    return c.json({ error: "current password is incorrect" }, 401);
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword) })
    .where(eq(users.id, user.id));

  // Revoke every other session — changing a password is how you get an
  // intruder out, so any session opened with the old one has to die. The
  // caller's own token survives so they aren't logged out of the tab they
  // just did this in.
  // Compare by row id, not by token: tokens are stored hashed now, so the
  // caller's raw header no longer equals anything in the table.
  const currentToken = bearerToken(c.req.header("Authorization"));
  const current = currentToken ? await findSession(db, currentToken) : null;
  const existing = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, user.id));

  for (const s of existing) {
    if (s.id !== current?.id) {
      await db.delete(sessions).where(eq(sessions.id, s.id));
    }
  }

  return c.json({ ok: true });
});

auth.post("/logout", requireAuth, async (c) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (token) {
    await deleteSession(getDb(c.env.DB), token);
  }
  return c.json({ ok: true });
});

export default auth;
