// The accent is stored on the account rather than the browser for one reason:
// people listening on a share link should see the owner's colour. So the test
// that matters isn't "the column updated" — it's that an unauthenticated
// invite resolve hands back the owner's accent, and that only colours the UI
// actually ships can ever get in there (the value lands in a CSS custom
// property on the listener's page).
import { describe, it, expect, beforeAll } from "vitest";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";

let db: Database;
let env: Record<string, unknown>;
let token: string;
let playlistId: string;
let shareToken: string;

const EMAIL = "accent@test.dev";
const PASSWORD = "accent-password";
const GREEN = "#3f6";

async function setAccent(accent: unknown, authToken = token): Promise<Response> {
  return app.request(
    "/auth/accent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ accent }),
    },
    env,
  );
}

beforeAll(async () => {
  db = createSqliteDb();
  setDbFactory(() => db);
  // This file models a two-account instance (an owner and a second signup), so
  // it has to opt out of the default first-account-only signup gate.
  env = { DB: "sqlite", DEMOS_BUCKET: {}, ALLOW_SIGNUP: "true" };

  const signup = await app.request(
    "/auth/signup",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    },
    env,
  );
  expect(signup.status).toBe(201);
  token = ((await signup.json()) as { token: string }).token;

  const playlist = await app.request(
    "/playlists",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "shared locker" }),
    },
    env,
  );
  expect(playlist.status).toBe(201);
  playlistId = ((await playlist.json()) as { playlist: { id: string } }).playlist.id;

  const share = await app.request(
    "/shares",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ playlistId, permission: "listen" }),
    },
    env,
  );
  expect(share.status).toBe(201);
  shareToken = ((await share.json()) as { share: { token: string } }).share.token;
});

describe("POST /auth/accent", () => {
  it("requires authentication", async () => {
    const res = await app.request(
      "/auth/accent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accent: GREEN }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a colour outside the shipped palette", async () => {
    // Not a style-sheet escape, just a colour the UI has no other way to reach.
    expect((await setAccent("#123456")).status).toBe(400);
  });

  it("rejects a value that would inject CSS", async () => {
    const res = await setAccent("red; background-image: url(https://evil.test/x)");
    expect(res.status).toBe(400);
    // and nothing was stored
    const me = await app.request("/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    const body = (await me.json()) as { user: { accent: string | null } };
    // `?? ""` so this asserts on content whether or not an accent was ever
    // stored — it must not depend on which test in this file ran first.
    expect(body.user.accent ?? "").not.toContain("url(");
  });

  it("rejects a non-string", async () => {
    expect((await setAccent(null)).status).toBe(400);
    expect((await setAccent(42)).status).toBe(400);
  });

  it("stores a palette colour and returns it from /auth/me", async () => {
    expect((await setAccent(GREEN)).status).toBe(200);

    const me = await app.request("/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    const body = (await me.json()) as { user: { accent: string | null } };
    expect(body.user.accent).toBe(GREEN);
  });

  it("comes back on login, so a fresh browser adopts it before /auth/me", async () => {
    const res = await app.request(
      "/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      },
      env,
    );
    const body = (await res.json()) as { user: { accent: string | null } };
    expect(body.user.accent).toBe(GREEN);
  });
});

describe("GET /shares/invite/:token", () => {
  it("hands the owner's accent to an unauthenticated listener", async () => {
    // No Authorization header — this is the whole point of storing it server-side.
    const res = await app.request(`/shares/invite/${shareToken}`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accent: string | null };
    expect(body.accent).toBe(GREEN);
  });

  it("returns null rather than a default when the owner never picked one", async () => {
    const signup = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "plain@test.dev", password: "plain-password" }),
      },
      env,
    );
    const plainToken = ((await signup.json()) as { token: string }).token;

    const playlist = await app.request(
      "/playlists",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plainToken}` },
        body: JSON.stringify({ name: "no accent" }),
      },
      env,
    );
    const plainPlaylistId = ((await playlist.json()) as { playlist: { id: string } }).playlist.id;

    const share = await app.request(
      "/shares",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plainToken}` },
        body: JSON.stringify({ playlistId: plainPlaylistId, permission: "listen" }),
      },
      env,
    );
    const plainShareToken = ((await share.json()) as { share: { token: string } }).share.token;

    const res = await app.request(`/shares/invite/${plainShareToken}`, {}, env);
    const body = (await res.json()) as { accent: string | null };
    expect(body.accent).toBeNull();
  });
});
