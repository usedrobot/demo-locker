// Changing a password is how you evict someone who already has your session
// token, so the interesting behaviour isn't "the password changed" — it's that
// the old password stops working and every OTHER session dies while the
// caller's own survives.
import { describe, it, expect, beforeAll } from "vitest";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";

let db: Database;
let env: Record<string, unknown>;

const EMAIL = "change-pw@test.dev";
const ORIGINAL = "original-password";
const REPLACEMENT = "replacement-password";

async function login(password: string): Promise<Response> {
  return app.request(
    "/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password }),
    },
    env,
  );
}

// Response.json() is typed `unknown` under this workspace's config, which the
// root typecheck enforces even though vitest itself doesn't care.
async function loginToken(password: string): Promise<string> {
  const res = await login(password);
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function changePassword(
  token: string,
  currentPassword: string,
  newPassword: string,
): Promise<Response> {
  return app.request(
    "/auth/change-password",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    },
    env,
  );
}

beforeAll(async () => {
  db = createSqliteDb();
  setDbFactory(() => db);
  env = { DB: "sqlite", DEMOS_BUCKET: {} };

  const res = await app.request(
    "/auth/signup",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: ORIGINAL }),
    },
    env,
  );
  expect(res.status).toBe(201);
});

describe("POST /auth/change-password", () => {
  it("requires authentication", async () => {
    const res = await app.request(
      "/auth/change-password",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: ORIGINAL, newPassword: REPLACEMENT }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a wrong current password even with a valid session", async () => {
    const token = await loginToken(ORIGINAL);
    const res = await changePassword(token, "not-the-password", REPLACEMENT);
    expect(res.status).toBe(401);
    // and the real password still works
    expect((await login(ORIGINAL)).status).toBe(200);
  });

  it("rejects a new password under 8 characters", async () => {
    const token = await loginToken(ORIGINAL);
    const res = await changePassword(token, ORIGINAL, "short");
    expect(res.status).toBe(400);
  });

  it("changes the password, kills other sessions, and keeps the caller's", async () => {
    const callerToken = await loginToken(ORIGINAL);
    const otherToken = await loginToken(ORIGINAL);
    expect(callerToken).not.toBe(otherToken);

    const res = await changePassword(callerToken, ORIGINAL, REPLACEMENT);
    expect(res.status).toBe(200);

    // the caller is still signed in
    const mine = await app.request("/auth/me", {
      headers: { Authorization: `Bearer ${callerToken}` },
    }, env);
    expect(mine.status).toBe(200);

    // the other session is gone
    const theirs = await app.request("/auth/me", {
      headers: { Authorization: `Bearer ${otherToken}` },
    }, env);
    expect(theirs.status).toBe(401);

    // old password rejected, new one accepted
    expect((await login(ORIGINAL)).status).toBe(401);
    expect((await login(REPLACEMENT)).status).toBe(200);
  });
});
