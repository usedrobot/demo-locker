// Local-disk storage for zero-dependency self-hosting.
// Content type is persisted in a "<file>.dlmeta" JSON sidecar.

import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { StorageBucket, StorageObject } from "./storage.js";

// Builds a pull-based web ReadableStream that does NOT open the underlying
// file (and therefore does not hold a file descriptor) until the first
// pull(). This matters because a caller (e.g. the range-request stream
// route) may call get() once just to inspect size/metadata and never read
// that first body — an eagerly-opened createReadStream would leak an fd on
// every such call.
function lazyFileStream(
  path: string,
  range?: { start: number; end: number },
): ReadableStream<Uint8Array> {
  let inner: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let nodeStream: ReturnType<typeof createReadStream> | null = null;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!inner) {
        nodeStream = range ? createReadStream(path, range) : createReadStream(path);
        inner = (Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>).getReader();
      }
      try {
        const { done, value } = await inner.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      nodeStream?.destroy();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 0 }));
  // highWaterMark: 0 disables the ReadableStream spec's default behavior of
  // eagerly calling pull() once right after construction to pre-fill the
  // internal queue — without this, the file would be opened on a microtask
  // shortly after get() returns, even if the consumer never reads the body.
}

export function createFsBucket(root: string): StorageBucket {
  const rootAbs = resolve(root);

  function pathFor(key: string): string {
    const p = resolve(rootAbs, key);
    if (p !== rootAbs && !p.startsWith(rootAbs + sep)) {
      throw new Error(`invalid storage key: ${key}`);
    }
    return p;
  }

  return {
    async put(key, body, options) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });

      let buf: Buffer;
      if (body instanceof Buffer) {
        buf = body;
      } else if (body instanceof ArrayBuffer) {
        buf = Buffer.from(body);
      } else {
        const chunks: Uint8Array[] = [];
        const reader = body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        buf = Buffer.concat(chunks);
      }

      await writeFile(path, buf as Uint8Array);
      const contentType = options?.httpMetadata?.contentType;
      if (contentType) {
        await writeFile(`${path}.dlmeta`, JSON.stringify({ contentType }));
      }
    },

    async get(key, options) {
      const path = pathFor(key);

      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        return null;
      }

      let contentType: string | undefined;
      try {
        contentType = JSON.parse(await readFile(`${path}.dlmeta`, "utf8")).contentType;
      } catch {
        // no sidecar — content type unknown
      }

      const body = lazyFileStream(
        path,
        options?.range
          ? {
              start: options.range.offset,
              end: options.range.offset + options.range.length - 1,
            }
          : undefined,
      );

      return {
        body,
        size,
        httpMetadata: { contentType },
      } as StorageObject;
    },

    async delete(key) {
      const path = pathFor(key);
      function logIfUnexpected(target: string) {
        return (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return;
          console.warn(`storage-fs: failed to delete ${target}: ${err.message}`);
        };
      }
      await unlink(path).catch(logIfUnexpected(key));
      await unlink(`${path}.dlmeta`).catch(logIfUnexpected(key));
    },
  };
}
