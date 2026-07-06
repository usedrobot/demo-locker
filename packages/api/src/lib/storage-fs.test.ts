import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBucket } from "./storage-fs.js";

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
    // size is the FULL object size (matches S3 driver semantics used by the
    // stream route to compute Content-Range)
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
    // eagerly, calling it 50x without reading any body would leak 50 fds.
    // We can't portably count open fds cross-platform (macOS has no
    // /proc/self/fd), so instead we prove laziness directly: delete the
    // underlying file *after* get() resolves but *before* reading the body.
    // With an eager createReadStream, the fd would already be open and the
    // read would still succeed. With a lazy stream, the file is opened only
    // on first read, so the read must fail once the file is gone.
    const bucket = createFsBucket(root);
    await bucket.put("lazy/track.wav", Buffer.from("some audio bytes"));

    const obj = await bucket.get("lazy/track.wav");
    expect(obj).not.toBeNull();

    await unlink(join(root, "lazy/track.wav"));

    await expect(streamToBuffer(obj!.body)).rejects.toThrow();
  });

  it("survives many unread get() calls without leaking fds, and a later body read still works", async () => {
    const bucket = createFsBucket(root);
    await bucket.put("busy/track.wav", Buffer.from("some audio bytes"));

    const objects = [];
    for (let i = 0; i < 50; i++) {
      objects.push(await bucket.get("busy/track.wav"));
    }

    // A fresh get()/read still works normally after 50 unread gets — proves
    // no fd exhaustion (EMFILE) and no eager-open crash.
    const fresh = await bucket.get("busy/track.wav");
    expect((await streamToBuffer(fresh!.body)).toString()).toBe("some audio bytes");

    // One of the earlier (unread) objects can still be read fine too.
    expect((await streamToBuffer(objects[25]!.body)).toString()).toBe("some audio bytes");
  });
});
