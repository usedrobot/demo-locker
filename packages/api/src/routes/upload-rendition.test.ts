// The upload endpoint stores an optional pre-encoded rendition produced in the
// browser. Without it, behaviour must be byte-identical to before: one object,
// streamKey === originalKey.
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";
import { createFsBucket } from "../lib/storage-fs.js";
import { users, sessions, tracks } from "../db/schema.js";

let db: Database;
let env: Record<string, unknown>;
let token: string;

beforeAll(async () => {
  db = createSqliteDb();
  setDbFactory(() => db);
  const root = await mkdtemp(join(tmpdir(), "dl-rendition-"));
  env = { DB: "sqlite", DEMOS_BUCKET: createFsBucket(root) };

  const [user] = await db
    .insert(users)
    .values({ email: "rendition@test.dev", passwordHash: "x" })
    .returning();
  token = "rendition-token";
  await db.insert(sessions).values({
    userId: user.id,
    token,
    expiresAt: new Date(Date.now() + 3600_000),
  });
});

async function upload(form: FormData): Promise<Response> {
  return app.request(
    "/tracks/upload",
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form },
    env,
  );
}

describe("upload with a stream rendition", () => {
  it("without a stream part, streamKey equals originalKey", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "song.wav", { type: "audio/wav" }));
    const res = await upload(form);
    expect(res.status).toBe(201);
    // Storage keys are no longer returned to clients (they were a durable
    // handle on a bucket object), so the divergence is asserted against the row.
    const { track } = (await res.json()) as { track: { id: string; hasStream: boolean } };
    expect(track.hasStream).toBe(true);
    const [row] = await db.select().from(tracks).where(eq(tracks.id, track.id));
    expect(row.streamKey).toBe(row.originalKey);
  });

  it("with a stream part, streamKey diverges and both objects are stored", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3, 4])], "song.wav", { type: "audio/wav" }));
    form.append("stream", new File([new Uint8Array([9, 9])], "song.m4a", { type: "audio/mp4" }));
    const res = await upload(form);
    expect(res.status).toBe(201);
    const { track } = (await res.json()) as { track: { id: string; hasStream: boolean } };
    expect(track.hasStream).toBe(true);

    const [row] = await db.select().from(tracks).where(eq(tracks.id, track.id));
    expect(row.streamKey).not.toBe(row.originalKey);
    expect(row.streamKey).toContain(".stream.m4a");

    // both objects really exist in the bucket
    const bucket = env.DEMOS_BUCKET as {
      get: (k: string) => Promise<{ body: unknown } | null>;
    };
    expect(await bucket.get(row.originalKey)).not.toBeNull();
    expect(await bucket.get(row.streamKey!)).not.toBeNull();
  });
});
