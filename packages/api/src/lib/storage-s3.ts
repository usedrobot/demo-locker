// S3-compatible storage for self-hosted (Node)

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { StorageBucket, StorageObject } from "./storage.js";

export function createS3Bucket(opts: {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
}): StorageBucket {
  const s3 = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region || "auto",
    credentials: {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    },
    forcePathStyle: true,
  });

  const bucket = opts.bucket;

  return {
    async put(key, body, options) {
      let buf: Buffer;
      if (body instanceof Buffer) {
        buf = body;
      } else if (body instanceof ArrayBuffer) {
        buf = Buffer.from(body);
      } else {
        // ReadableStream → Buffer
        const chunks: Uint8Array[] = [];
        const reader = body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        buf = Buffer.concat(chunks);
      }

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buf,
          ContentType: options?.httpMetadata?.contentType,
        })
      );
    },

    async get(key, options) {
      const params: Record<string, unknown> = { Bucket: bucket, Key: key };
      if (options?.range) {
        const end = options.range.offset + options.range.length - 1;
        params.Range = `bytes=${options.range.offset}-${end}`;
      }

      const res = await s3.send(new GetObjectCommand(params as any));
      if (!res.Body) return null;

      return {
        body: res.Body.transformToWebStream(),
        size: res.ContentLength ?? undefined,
        httpMetadata: { contentType: res.ContentType ?? undefined },
      } as StorageObject;
    },

    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
