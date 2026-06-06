import { createHash, createHmac } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@hootifactory/config";
import { z } from "@hootifactory/core";
import { S3Client } from "bun";
import { blobKey, computeDigest, InvalidDigestError } from "./digest";
import type { BlobData, BlobStat, BlobStore, PutResult } from "./types";

const S3MissingObjectErrorSchema = z.looseObject({
  code: z.literal("NoSuchKey"),
});

/**
 * True only for a genuine "object does not exist" S3 error. Bun surfaces these
 * as an S3Error with code "NoSuchKey". Any other failure (auth, network,
 * missing bucket → "UnknownError"/"NoSuchBucket", etc.) must NOT be treated as
 * "blob absent", or transient/config faults silently look like data loss.
 */
function isObjectMissing(err: unknown): boolean {
  return S3MissingObjectErrorSchema.safeParse(err).success;
}

async function streamToTempFile(
  data: ReadableStream<Uint8Array>,
): Promise<{ path: string; digest: string; size: number }> {
  const dir = await mkdtemp(join(tmpdir(), "hootifactory-blob-"));
  const path = join(dir, "payload");
  const out = createWriteStream(path, { flags: "wx" });
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = data.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      size += value.byteLength;
      if (!out.write(value)) {
        await new Promise<void>((resolve, reject) => {
          out.once("drain", resolve);
          out.once("error", reject);
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    return { path, digest: `sha256:${hasher.digest("hex")}`, size };
  } catch (err) {
    out.destroy();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export interface S3BlobStoreOptions {
  endpoint?: string;
  publicEndpoint?: string;
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

  constructor(opts: S3BlobStoreOptions = {}) {
    this.endpoint = opts.endpoint ?? env.S3_ENDPOINT;
    this.publicEndpoint = opts.publicEndpoint ?? env.S3_PUBLIC_ENDPOINT;
    this.region = opts.region ?? env.S3_REGION;
    this.bucket = opts.bucket ?? env.S3_BUCKET;
    this.accessKeyId = opts.accessKeyId ?? env.S3_ACCESS_KEY_ID;
    this.secretAccessKey = opts.secretAccessKey ?? env.S3_SECRET_ACCESS_KEY;
    this.forcePathStyle = env.S3_FORCE_PATH_STYLE;
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
      return response.ok;
    } catch {
      return false;
    }
  }
}

function encodeS3Path(value: string): string {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function joinUrlPath(...parts: string[]): string {
  return `/${parts
    .map((part) => trimSlashes(part))
    .filter(Boolean)
    .join("/")}`;
}

// Trim leading/trailing slashes without a backtracking-prone anchored regex
// (`/^\/+|\/+$/`), which CodeQL flags as polynomial ReDoS.
function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "/") start++;
  while (end > start && value[end - 1] === "/") end--;
  return value.slice(start, end);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacSha256Hex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function signingKey(secretAccessKey: string, date: string, region: string): Buffer {
  const dateKey = hmacSha256(`AWS4${secretAccessKey}`, date);
  const regionKey = hmacSha256(dateKey, region);
  const serviceKey = hmacSha256(regionKey, "s3");
  return hmacSha256(serviceKey, "aws4_request");
}

function signedCopyObjectRequest(input: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  sourceKey: string;
  targetKey: string;
}): { url: string; headers: Record<string, string> } {
  const endpoint = new URL(input.endpoint);
  const basePath = endpoint.pathname === "/" ? "" : endpoint.pathname;
  const targetPath = encodeS3Path(input.targetKey);
  const bucketPath = encodeURIComponent(input.bucket);
  const pathname = input.forcePathStyle
    ? joinUrlPath(basePath, bucketPath, targetPath)
    : joinUrlPath(basePath, targetPath);
  const host = input.forcePathStyle ? endpoint.host : `${input.bucket}.${endpoint.host}`;
  const url = new URL(endpoint.toString());
  url.host = host;
  url.pathname = pathname;
  url.search = "";

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256Hex("");
  const copySource = `/${encodeURIComponent(input.bucket)}/${encodeS3Path(input.sourceKey)}`;
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-copy-source": copySource,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}:${value.trim()}\n`)
    .join("");
  const canonicalRequest = [
    "PUT",
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmacSha256Hex(
    signingKey(input.secretAccessKey, date, input.region),
    stringToSign,
  );

  return {
    url: url.toString(),
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}
