// The original upload must stay reachable once streamKey diverges from
// originalKey, and must be gated exactly like /stream — an unauthenticated
// caller gets the same non-enumerable 404, not a 401.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";
import { createFsBucket } from "../lib/storage-fs.js";
import { users, sessions } from "../db/schema.js";

let db: Database;
let env: Record<string, unknown>;
let ownerToken: string;
let strangerToken: string;
let trackId: string;

const ORIGINAL_BYTES = new Uint8Array([11, 22, 33, 44, 55]);

beforeAll(async () => {
  db = createSqliteDb();
  setDbFactory(() => db);
  const root = await mkdtemp(join(tmpdir(), "dl-download-"));
  env = { DB: "sqlite", DEMOS_BUCKET: createFsBucket(root) };

  const [owner] = await db
    .insert(users)
    .values({ email: "dl-owner@test.dev", passwordHash: "x" })
    .returning();
  const [stranger] = await db
    .insert(users)
    .values({ email: "dl-stranger@test.dev", passwordHash: "x" })
    .returning();
  ownerToken = "dl-owner-token";
  strangerToken = "dl-stranger-token";
  const expiresAt = new Date(Date.now() + 3600_000);
  await db.insert(sessions).values([
    { userId: owner.id, token: ownerToken, expiresAt },
    { userId: stranger.id, token: strangerToken, expiresAt },
  ]);

  // upload a library track with a distinct rendition, so original != stream
  const form = new FormData();
  form.append("file", new File([ORIGINAL_BYTES], "master.wav", { type: "audio/wav" }));
  form.append("stream", new File([new Uint8Array([7, 7])], "master.m4a", { type: "audio/mp4" }));
  const res = await app.request(
    "/tracks/upload",
    { method: "POST", headers: { Authorization: `Bearer ${ownerToken}` }, body: form },
    env,
  );
  const body = (await res.json()) as { track: { id: string } };
  trackId = body.track.id;
});

describe("GET /tracks/:id/download", () => {
  it("serves the original bytes to the owner, not the rendition", async () => {
    const res = await app.request(
      `/tracks/${trackId}/download`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(ORIGINAL_BYTES));
  });

  it("404s for a stranger", async () => {
    const res = await app.request(
      `/tracks/${trackId}/download`,
      { headers: { Authorization: `Bearer ${strangerToken}` } },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("404s with no credentials at all", async () => {
    const res = await app.request(`/tracks/${trackId}/download`, {}, env);
    expect(res.status).toBe(404);
  });
});
