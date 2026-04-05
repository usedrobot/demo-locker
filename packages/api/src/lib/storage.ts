// Storage abstraction — implemented by R2 (Worker) and S3 (self-hosted)

export interface StorageBucket {
  put(key: string, body: ReadableStream | ArrayBuffer | Buffer, options?: { httpMetadata?: { contentType?: string } }): Promise<void>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<StorageObject | null>;
  delete(key: string): Promise<void>;
}

export interface StorageObject {
  body: ReadableStream;
  size?: number;
  httpMetadata?: { contentType?: string };
}
