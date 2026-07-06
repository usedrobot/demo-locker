// Shared range-capable audio streaming used by the private and public stream routes.

import type { StorageBucket } from "./storage.js";

export async function buildStreamResponse(
  rangeHeader: string | undefined,
  bucket: StorageBucket,
  key: string
): Promise<Response> {
  const object = await bucket.get(key);
  if (!object) {
    return Response.json({ error: "file not found" }, { status: 404 });
  }

  const headers = new Headers();
  headers.set("Content-Type", object.httpMetadata?.contentType || "audio/mpeg");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=3600");

  if (rangeHeader && object.size) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : object.size - 1;
      const sliced = await bucket.get(key, {
        range: { offset: start, length: end - start + 1 },
      });
      if (sliced) {
        headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
        headers.set("Content-Length", String(end - start + 1));
        return new Response(sliced.body, { status: 206, headers });
      }
    }
  }

  if (object.size) {
    headers.set("Content-Length", String(object.size));
  }

  return new Response(object.body, { headers });
}
