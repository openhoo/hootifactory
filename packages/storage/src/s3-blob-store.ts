import { rm } from "node:fs/promises";
import { env } from "@hootifactory/config";
import { S3Client } from "bun";
import { blobKey, computeDigest, InvalidDigestError } from "./digest";
import { signedCopyObjectRequest } from "./s3-client";
import { isObjectMissing } from "./s3-errors";
import { streamToTempFile, waitForDrain } from "./s3-streaming";
import type { BlobData, BlobStat, BlobStore, PutResult } from "./types";

// Re-exported so `import { waitForDrain } from "./s3-blob-store"` keeps working
// for callers (and tests) that depended on this module's surface.
export { waitForDrain };

export interface S3BlobStoreOptions {
  endpoint?: string;
  publicEndpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Force path-style addressing (MinIO and other non-AWS S3 backends need it). */
  forcePathStyle?: boolean;
  /**
   * Invoked when the SigV4-signed server-side CopyObject fails (network error
   * or non-2xx response) before promoteToBlob falls back to a full streaming
   * re-copy. Wire this to the application's logger: without it, a persistent
   * misconfiguration (e.g. bad credentials) silently degrades every promote to
   * the slow path. Not called for the expected "no endpoint/credentials
   * configured" skip. Must not throw; exceptions are swallowed defensively.
   */
  onCopyError?: (error: unknown, context: { sourceKey: string; targetKey: string }) => void;
}

async function toBytes(data: Exclude<BlobData, ReadableStream<Uint8Array>>): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  // Unreachable by type (ReadableStream is excluded from BlobData here). Reaching
  // this means a type-violating caller; fail loudly rather than handing a stream
  // to S3File.write(), which would silently corrupt the stored blob.
  throw new TypeError("toBytes: unsupported BlobData (ReadableStream is not allowed here)");
}

/** S3-compatible (S3 / MinIO / R2) content-addressable blob store via Bun's native S3 client. */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly publicClient?: S3Client;
  private readonly endpoint?: string;
  private readonly publicEndpoint?: string;
  private readonly region: string;
  private readonly bucket?: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;
  private readonly forcePathStyle: boolean;
  private readonly onCopyError?: S3BlobStoreOptions["onCopyError"];

  constructor(opts: S3BlobStoreOptions = {}) {
    this.endpoint = opts.endpoint ?? env.S3_ENDPOINT;
    this.publicEndpoint = opts.publicEndpoint ?? env.S3_PUBLIC_ENDPOINT;
    this.region = opts.region ?? env.S3_REGION;
    this.bucket = opts.bucket ?? env.S3_BUCKET;
    this.accessKeyId = opts.accessKeyId ?? env.S3_ACCESS_KEY_ID;
    this.secretAccessKey = opts.secretAccessKey ?? env.S3_SECRET_ACCESS_KEY;
    this.forcePathStyle = opts.forcePathStyle ?? env.S3_FORCE_PATH_STYLE;
    this.onCopyError = opts.onCopyError;
    this.client = new S3Client({
      endpoint: this.endpoint,
      region: this.region,
      bucket: this.bucket,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      // MinIO and other non-AWS S3 backends require path-style addressing.
      virtualHostedStyle: !this.forcePathStyle,
    });
    this.publicClient = this.publicEndpoint
      ? new S3Client({
          endpoint: this.publicEndpoint,
          region: this.region,
          bucket: this.bucket,
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey,
          virtualHostedStyle: !this.forcePathStyle,
        })
      : undefined;
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

  async put(
    data: Exclude<BlobData, ReadableStream<Uint8Array>>,
    knownDigest?: string,
  ): Promise<PutResult> {
    const bytes = await toBytes(data);
    const digest = knownDigest ?? computeDigest(bytes);
    const key = this.blobKey(digest);
    if (await this.existsKey(key)) {
      return { digest, size: bytes.byteLength, deduped: true };
    }
    await this.file(key).write(bytes);
    return { digest, size: bytes.byteLength, deduped: false };
  }

  async putStream(data: ReadableStream<Uint8Array>, expectedDigest?: string): Promise<PutResult> {
    const temp = await streamToTempFile(data);
    const dir = temp.path.slice(0, temp.path.lastIndexOf("/"));
    try {
      if (expectedDigest && temp.digest !== expectedDigest) {
        throw new InvalidDigestError(
          `putStream mismatch: expected ${expectedDigest}, got ${temp.digest}`,
        );
      }
      const key = this.blobKey(temp.digest);
      if (await this.existsKey(key)) {
        return { digest: temp.digest, size: temp.size, deduped: true };
      }
      await this.file(key).write(Bun.file(temp.path));
      return { digest: temp.digest, size: temp.size, deduped: false };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async delete(digest: string): Promise<void> {
    await this.deleteKey(this.blobKey(digest));
  }

  presignGet(digest: string, expiresIn = 300): string {
    return this.file(this.blobKey(digest)).presign({ method: "GET", expiresIn });
  }

  publicPresignGet(digest: string, expiresIn = 300): string | null {
    if (!this.publicClient) return null;
    return this.publicClient.file(this.blobKey(digest)).presign({ method: "GET", expiresIn });
  }

  // ── raw-key (staging) ───────────────────────────────────────────────────
  async putAtKey(key: string, data: Exclude<BlobData, ReadableStream<Uint8Array>>): Promise<void> {
    await this.file(key).write(await toBytes(data));
  }

  async putStreamAtKey(key: string, data: ReadableStream<Uint8Array>): Promise<void> {
    const temp = await streamToTempFile(data);
    const dir = temp.path.slice(0, temp.path.lastIndexOf("/"));
    try {
      await this.file(key).write(Bun.file(temp.path));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
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
    } catch (err) {
      if (isObjectMissing(err)) return null;
      throw err;
    }
  }

  async deleteKey(key: string): Promise<void> {
    await this.file(key).delete();
  }

  async promoteToBlob(stagingKey: string, digest: string): Promise<void> {
    const key = this.blobKey(digest);
    if (await this.existsKey(key)) return; // idempotent dedup
    if (await this.copyObject(stagingKey, key)) return;
    await this.putStream(this.readKey(stagingKey), digest);
  }

  presignPutKey(key: string, expiresIn = 300): string {
    return this.file(key).presign({ method: "PUT", expiresIn });
  }

  private async copyObject(sourceKey: string, targetKey: string): Promise<boolean> {
    if (!this.endpoint || !this.bucket || !this.accessKeyId || !this.secretAccessKey) return false;
    const request = signedCopyObjectRequest({
      endpoint: this.endpoint,
      region: this.region,
      bucket: this.bucket,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      forcePathStyle: this.forcePathStyle,
      sourceKey,
      targetKey,
    });
    try {
      const response = await fetch(request.url, { method: "PUT", headers: request.headers });
      // Drain the body so the connection returns to the pool immediately instead
      // of waiting for GC to collect the unconsumed Response.
      await response.body?.cancel().catch(() => {});
      if (!response.ok) {
        this.reportCopyError(
          new Error(`S3 CopyObject responded with HTTP ${response.status}`),
          sourceKey,
          targetKey,
        );
        return false;
      }
      return true;
    } catch (err) {
      this.reportCopyError(err, sourceKey, targetKey);
      return false;
    }
  }

  /** Surface a copy failure to the injected hook without letting it break the fallback path. */
  private reportCopyError(error: unknown, sourceKey: string, targetKey: string): void {
    try {
      this.onCopyError?.(error, { sourceKey, targetKey });
    } catch {
      // The hook is observability-only; a throwing hook must not turn a
      // recoverable copy failure into a failed promote.
    }
  }
}
