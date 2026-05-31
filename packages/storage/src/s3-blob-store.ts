import { env } from "@hootifactory/config";
import { S3Client } from "bun";
import { blobKey, computeDigest } from "./digest";
import type { BlobData, BlobStat, BlobStore, PutResult } from "./types";

export interface S3BlobStoreOptions {
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

async function toBytes(data: Exclude<BlobData, ReadableStream<Uint8Array>>): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return data;
}

/** S3-compatible (S3 / MinIO / R2) content-addressable blob store via Bun's native S3 client. */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;

  constructor(opts: S3BlobStoreOptions = {}) {
    this.client = new S3Client({
      endpoint: opts.endpoint ?? env.S3_ENDPOINT,
      region: opts.region ?? env.S3_REGION,
      bucket: opts.bucket ?? env.S3_BUCKET,
      accessKeyId: opts.accessKeyId ?? env.S3_ACCESS_KEY_ID,
      secretAccessKey: opts.secretAccessKey ?? env.S3_SECRET_ACCESS_KEY,
    });
  }

  private file(key: string) {
    return this.client.file(key);
  }

  blobKey(digest: string): string {
    return blobKey(digest);
  }

  async exists(digest: string): Promise<boolean> {
    return this.existsKey(this.blobKey(digest));
  }

  async stat(digest: string): Promise<BlobStat | null> {
    return this.statKey(this.blobKey(digest));
  }

  get(digest: string): ReadableStream<Uint8Array> {
    return this.file(this.blobKey(digest)).stream();
  }

  getRange(digest: string, start: number, end?: number): ReadableStream<Uint8Array> {
    const f = this.file(this.blobKey(digest));
    return (end === undefined ? f.slice(start) : f.slice(start, end)).stream();
  }

  async getBytes(digest: string): Promise<Uint8Array> {
    return new Uint8Array(await this.file(this.blobKey(digest)).arrayBuffer());
  }

  async put(data: Exclude<BlobData, ReadableStream<Uint8Array>>): Promise<PutResult> {
    const bytes = await toBytes(data);
    const digest = computeDigest(bytes);
    const key = this.blobKey(digest);
    if (await this.existsKey(key)) {
      return { digest, size: bytes.byteLength, deduped: true };
    }
    await this.file(key).write(bytes);
    return { digest, size: bytes.byteLength, deduped: false };
  }

  async delete(digest: string): Promise<void> {
    await this.deleteKey(this.blobKey(digest));
  }

  presignGet(digest: string, expiresIn = 300): string {
    return this.file(this.blobKey(digest)).presign({ method: "GET", expiresIn });
  }

  // ── raw-key (staging) ───────────────────────────────────────────────────
  async putAtKey(key: string, data: Exclude<BlobData, ReadableStream<Uint8Array>>): Promise<void> {
    await this.file(key).write(await toBytes(data));
  }

  readKey(key: string): ReadableStream<Uint8Array> {
    return this.file(key).stream();
  }

  async bytesAtKey(key: string): Promise<Uint8Array> {
    return new Uint8Array(await this.file(key).arrayBuffer());
  }

  async existsKey(key: string): Promise<boolean> {
    return this.file(key).exists();
  }

  async statKey(key: string): Promise<BlobStat | null> {
    const f = this.file(key);
    try {
      const s = await f.stat();
      return { size: s.size, etag: (s as { etag?: string }).etag };
    } catch {
      return null;
    }
  }

  async deleteKey(key: string): Promise<void> {
    await this.file(key).delete();
  }

  async promoteToBlob(stagingKey: string, digest: string): Promise<void> {
    // NOTE: buffers the blob in memory. Fine for metadata/tarballs/wheels; the
    // Docker adapter uses a chunk-streaming promote for large layers.
    const bytes = await this.bytesAtKey(stagingKey);
    await this.file(this.blobKey(digest)).write(bytes);
  }

  presignPutKey(key: string, expiresIn = 300): string {
    return this.file(key).presign({ method: "PUT", expiresIn });
  }
}
