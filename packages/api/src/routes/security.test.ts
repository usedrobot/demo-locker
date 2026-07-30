// Regression tests for the 2026-07-30 security review. Each of these was a
// working exploit against the previous release, reproduced here in the shape it
// was actually run: two accounts, a share, a revocation, a probe.
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";
import { tracks, playlists } from "../db/schema.js";

let db: Database;
let env: Record<string, unknown>;
let victimToken: string;
let victimPlaylist: string;
let victimTrack: string;
let victimTrackKey: string;
let attackerToken: string;
let attackerPlaylist: string;

async function json(res: Response) {
  return (await res.json()) as any;
}

async function signup(email: string): Promise<string> {
  const res = await app.request(
    "/auth/signup",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "a-good-password" }),
    },
    env,
  );
  expect(res.status).toBe(201);
  return (await json(res)).token;
}

async function createPlaylist(token: string, name: string): Promise<string> {
  const res = await app.request(
    "/playlists",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name }),
    },
    env,
  );
  return (await json(res)).playlist.id;
}

async function uploadTrack(token: string, playlistId: string): Promise<string> {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([1, 2, 3, 4])], "master.wav", { type: "audio/wav" }));
  form.append("playlistId", playlistId);
  const res = await app.request(
    "/tracks/upload",
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form },
    env,
  );
  expect(res.status).toBe(201);
  return (await json(res)).track.id;
}

beforeAll(async () => {
  db = createSqliteDb();
  setDbFactory(() => db);
  // The stub records the content type it was given and hands the same one
  // back. A stub that always answered "audio/wav" would make the
  // stored-content-type test pass without ever exercising a text/html row.
  const store = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  env = {
    DB: "sqlite",
    // Two accounts, so the gate has to be open for this file.
    ALLOW_SIGNUP: "true",
    DEMOS_BUCKET: {
      async put(key: string, _body: unknown, options?: { httpMetadata?: { contentType?: string } }) {
        store.set(key, {
          bytes: new Uint8Array([1, 2, 3, 4]),
          contentType: options?.httpMetadata?.contentType,
        });
      },
      async get(key: string) {
        const entry = store.get(key);
        if (!entry) return null;
        return {
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(entry.bytes);
              controller.close();
            },
          }),
          size: entry.bytes.length,
          httpMetadata: { contentType: entry.contentType },
        };
      },
      async delete(key: string) {
        store.delete(key);
      },
    },
  };

  victimToken = await signup("victim@sec.test");
  victimPlaylist = await createPlaylist(victimToken, "Victim Private");
  victimTrack = await uploadTrack(victimToken, victimPlaylist);
  const [row] = await db.select().from(tracks).where(eq(tracks.id, victimTrack));
  victimTrackKey = row.originalKey;

  attackerToken = await signup("attacker@sec.test");
  attackerPlaylist = await createPlaylist(attackerToken, "Attacker");
});

describe("artworkKey is not a client-writable pointer into the bucket", () => {
  it("ignores artworkKey in PATCH, so it can't be aimed at another account's object", async () => {
    const res = await app.request(
      `/playlists/${attackerPlaylist}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${attackerToken}` },
        body: JSON.stringify({ artworkKey: victimTrackKey }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect((await json(res)).playlist.artworkKey).toBeNull();
  });

  it("does not serve the victim's master through the attacker's artwork route", async () => {
    const res = await app.request(
      `/playlists/${attackerPlaylist}/artwork`,
      { headers: { Authorization: `Bearer ${attackerToken}` } },
      env,
    );
    // No artwork was ever set on this playlist, and the PATCH above could not
    // set one — the original exploit returned 200 with the victim's bytes.
    expect(res.status).toBe(404);
  });
});

describe("storage keys stay server-side", () => {
  it("omits originalKey/streamKey from a listen-only share's view", async () => {
    const shareRes = await app.request(
      "/shares",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${victimToken}` },
        body: JSON.stringify({ playlistId: victimPlaylist, permission: "listen" }),
      },
      env,
    );
    const shareToken = (await json(shareRes)).share.token;

    const res = await app.request(`/playlists/${victimPlaylist}?token=${shareToken}`, {}, env);
    const body = await json(res);
    expect(body.tracks[0].originalKey).toBeUndefined();
    expect(body.tracks[0].streamKey).toBeUndefined();
    expect(body.tracks[0].hasStream).toBe(true);
  });
});

describe("reorder cannot reach tracks in another playlist", () => {
  it("leaves a foreign track's position untouched", async () => {
    const [before] = await db.select().from(tracks).where(eq(tracks.id, victimTrack));

    const res = await app.request(
      `/playlists/${attackerPlaylist}/reorder`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${attackerToken}` },
        // Padding so the victim's track would land on a different index than
        // it already has — otherwise the assertion could pass by coincidence.
        body: JSON.stringify({ trackIds: ["x1", "x2", "x3", "x4", "x5", "x6", "x7", victimTrack] }),
      },
      env,
    );
    expect(res.status).toBe(200);

    const [after] = await db.select().from(tracks).where(eq(tracks.id, victimTrack));
    expect(after.position).toBe(before.position);
  });
});

describe("uploaded content types cannot be served as markup", () => {
  it("rejects a text/html artwork upload outright", async () => {
    const form = new FormData();
    form.append("file", new File(["<script>alert(1)</script>"], "x.html", { type: "text/html" }));
    const res = await app.request(
      `/playlists/${attackerPlaylist}/artwork`,
      { method: "POST", headers: { Authorization: `Bearer ${attackerToken}` }, body: form },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("neutralises a text/html type already stored, rather than echoing it", async () => {
    // A row as it would look if written before the upload allowlist existed:
    // the object is in the bucket declaring text/html and the playlist points
    // at it. Written through drizzle, and the response asserted
    // unconditionally — an earlier version of this test guarded its assertions
    // behind `if (res.status === 200)` and passed with the fix reverted.
    const key = `playlist-art/${attackerPlaylist}.html`;
    await (env.DEMOS_BUCKET as any).put(key, new Uint8Array([1]), {
      httpMetadata: { contentType: "text/html" },
    });
    await db
      .update(playlists)
      .set({ artworkKey: key })
      .where(eq(playlists.id, attackerPlaylist));

    const res = await app.request(
      `/playlists/${attackerPlaylist}/artwork`,
      { headers: { Authorization: `Bearer ${attackerToken}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("registration closes once the instance has an owner", () => {
  it("refuses a second signup when ALLOW_SIGNUP is not set", async () => {
    const closedEnv = { ...env, ALLOW_SIGNUP: undefined };
    const res = await app.request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "stranger@sec.test", password: "a-good-password" }),
      },
      closedEnv,
    );
    expect(res.status).toBe(403);
  });
});

describe("security headers", () => {
  it("sets nosniff on API responses", async () => {
    const res = await app.request("/health", {}, env);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
