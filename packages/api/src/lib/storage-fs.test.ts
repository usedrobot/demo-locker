import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBucket } from "./storage-fs.js";

const createReadStreamSpy = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      createReadStreamSpy.count++;
      return actual.createReadStream(...args);
    },
  };
});

async function streamToBuffer(stream: ReadableStream): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

describe("createFsBucket", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dl-fs-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a put/get with content type and size", async () => {
    const bucket = createFsBucket(root);
    const data = Buffer.from("hello demo locker");
    await bucket.put("pl1/track1/song.wav", data, {
      httpMetadata: { contentType: "audio/wav" },
    });

    const obj = await bucket.get("pl1/track1/song.wav");
    expect(obj).not.toBeNull();
    expect(obj!.size).toBe(data.length);
    expect(obj!.httpMetadata?.contentType).toBe("audio/wav");
    expect((await streamToBuffer(obj!.body)).toString()).toBe("hello demo locker");
  });

  it("accepts ArrayBuffer and ReadableStream bodies", async () => {
    const bucket = createFsBucket(root);
    const bytes = new TextEncoder().encode("stream body");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    await bucket.put("a/ab.bin", bytes.buffer as ArrayBuffer);
    await bucket.put("a/stream.bin", stream);

    expect((await streamToBuffer((await bucket.get("a/ab.bin"))!.body)).toString()).toBe("stream body");
    expect((await streamToBuffer((await bucket.get("a/stream.bin"))!.body)).toString()).toBe("stream body");
  });

  it("serves range reads", async () => {
    const bucket = createFsBucket(root);
    await bucket.put("k", Buffer.from("0123456789"));

    const obj = await bucket.get("k", { range: { offset: 2, length: 4 } });
    expect((await streamToBuffer(obj!.body)).toString()).toBe("2345");
    // size is the FULL object size. NOTE: the S3 driver returns the partial
    // slice length on ranged gets; callers must not rely on size after a
    // ranged get — tracks.ts derives Content-Range from an unranged get.
    expect(obj!.size).toBe(10);
  });

  it("returns null for a missing key", async () => {
    const bucket = createFsBucket(root);
    expect(await bucket.get("nope")).toBeNull();
  });

  it("deletes objects", async () => {
    const bucket = createFsBucket(root);
    await bucket.put("gone", Buffer.from("x"));
    await bucket.delete("gone");
    expect(await bucket.get("gone")).toBeNull();
    // deleting again is a no-op, not an error
    await bucket.delete("gone");
  });

  it("rejects path-traversal keys", async () => {
    const bucket = createFsBucket(root);
    await expect(bucket.put("../evil", Buffer.from("x"))).rejects.toThrow(/invalid storage key/);
    await expect(bucket.get("../../etc/passwd")).rejects.toThrow(/invalid storage key/);
    await expect(bucket.delete("a/../../evil")).rejects.toThrow(/invalid storage key/);
  });

  it("does not eagerly open the file on get() — body stream is lazy (fd leak regression)", async () => {
    // Regression test for a leaked file descriptor: the stream route calls
    // get() once for size/metadata (and may never read that body), then
    // calls get() again for the actual range read. If get() opened the file
    // eagerly, calling it N times without reading any body would leak N fds.
    // We prove laziness directly by spying on node:fs's createReadStream and
    // counting invocations, rather than racing an unlink against the async
    // open (which is not discriminating — it also "passes" against an eager
    // implementation whenever the unlink wins the race).
    const bucket = createFsBucket(root);
    await bucket.put("lazy/track.wav", Buffer.from("some audio bytes"));

    createReadStreamSpy.count = 0;

    const obj = await bucket.get("lazy/track.wav");
    expect(obj).not.toBeNull();
    const rangedObj = await bucket.get("lazy/track.wav", { range: { offset: 0, length: 4 } });
    expect(rangedObj).not.toBeNull();

    // Two get() calls, no reads yet — the file must not have been opened.
    expect(createReadStreamSpy.count).toBe(0);

    expect((await streamToBuffer(obj!.body)).toString()).toBe("some audio bytes");
    expect(createReadStreamSpy.count).toBe(1);

    // The second (ranged) body was never read — still lazy, still unopened.
    expect(createReadStreamSpy.count).toBe(1);
  });

  it("cancel() on an unread body does not error, and never opens more than once", async () => {
    const bucket = createFsBucket(root);
    await bucket.put("cancel/track.wav", Buffer.from("some audio bytes"));

    createReadStreamSpy.count = 0;

    const obj = await bucket.get("cancel/track.wav");
    await expect(obj!.body.cancel()).resolves.not.toThrow();

    // Cancelling before any read may or may not have opened the file
    // (spec allows either), but it must never open more than once.
    expect(createReadStreamSpy.count).toBeLessThanOrEqual(1);
  });
});
