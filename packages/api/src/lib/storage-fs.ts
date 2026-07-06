// Local-disk storage for zero-dependency self-hosting.
// Content type is persisted in a "<file>.dlmeta" JSON sidecar.

import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { StorageBucket, StorageObject } from "./storage.js";

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

      const nodeStream = options?.range
        ? createReadStream(path, {
            start: options.range.offset,
            end: options.range.offset + options.range.length - 1,
          })
        : createReadStream(path);

      return {
        body: Readable.toWeb(nodeStream) as unknown as ReadableStream,
        size,
        httpMetadata: { contentType },
      } as StorageObject;
    },

    async delete(key) {
      const path = pathFor(key);
      await unlink(path).catch(() => {});
      await unlink(`${path}.dlmeta`).catch(() => {});
    },
  };
}
