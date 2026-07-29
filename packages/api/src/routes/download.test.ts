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
import { contentDispositionHeader } from "./tracks.js";

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

// The filename baked into Content-Disposition comes straight from the
// user's upload (file.name), unsanitized. Building a Headers/Response with
// a raw non-Latin1 or control-character filename throws ("Cannot convert
// argument to a ByteString" / "invalid header value"), which without an
// app.onError handler surfaces as an unhandled 500 — a legitimate owner
// asking for their own file gets nothing. These cases must not throw.
describe("contentDispositionHeader", () => {
  const cases: Array<[string, string]> = [
    ["plain ascii", "Midnight Under the Palms.wav"],
    ["accented latin-1", "démo.wav"],
    ["emoji", "🔥 banger.wav"],
    ["CJK", "夜明け.wav"],
    ["embedded double quote", 'my "demo" track.wav'],
    ["embedded backslash", "back\\slash.wav"],
    ["embedded newline", "bad\nname.wav"],
    ["embedded CR", "bad\rname.wav"],
  ];

  it.each(cases)("does not throw for %s", (_label, filename) => {
    let header = "";
    expect(() => {
      header = contentDispositionHeader(filename);
    }).not.toThrow();

    // Must actually be usable as a header value (this is the real assertion
    // the bug violated — the string alone can look fine and still throw).
    expect(() => new Headers({ "Content-Disposition": header })).not.toThrow();
  });

  it("carries the real name via filename*, and a sanitized ascii fallback via filename=", () => {
    const header = contentDispositionHeader("🔥 banger.wav");
    expect(header).toContain("attachment");
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent("🔥 banger.wav")}`);
    expect(header).not.toContain("🔥");
  });

  it("strips quotes and backslashes from the ascii fallback", () => {
    const header = contentDispositionHeader('my "demo" track.wav');
    const fallbackMatch = header.match(/filename="([^"]*)"/);
    expect(fallbackMatch?.[1]).not.toContain('"');
    expect(fallbackMatch?.[1]).not.toContain("\\");
  });

  it("falls back to a default name when nothing ascii-safe survives", () => {
    const header = contentDispositionHeader("夜明け.wav".replace(/[a-zA-Z0-9.]/g, ""));
    expect(header).toMatch(/filename="download"/);
  });
});

// End-to-end: an upload whose filename is emoji/CJK must still be
// downloadable, not 500 on Content-Disposition construction.
describe("GET /tracks/:id/download with a non-ASCII filename", () => {
  it("serves the file without throwing on header construction", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const form = new FormData();
    form.append("file", new File([bytes], "🔥 夜明け démo.wav", { type: "audio/wav" }));
    const uploadRes = await app.request(
      "/tracks/upload",
      { method: "POST", headers: { Authorization: `Bearer ${ownerToken}` }, body: form },
      env,
    );
    expect(uploadRes.status).toBe(201);
    const { track } = (await uploadRes.json()) as { track: { id: string } };

    const res = await app.request(
      `/tracks/${track.id}/download`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    const returned = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(returned)).toEqual(Array.from(bytes));
  });
});
