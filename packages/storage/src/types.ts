export type BlobData = Uint8Array | ArrayBuffer | Blob | string | ReadableStream<Uint8Array>;

export interface BlobStat {
  size: number;
  etag?: string;
}

export interface PutResult {
  digest: string;
  size: number;
  /** True when the blob already existed (no bytes written). */
  deduped: boolean;
}

/**
 * Backend-agnostic content-addressable blob store. Digest-keyed methods operate
 * on the immutable CAS; raw-key methods operate on staging keys for resumable
 * uploads. Authorization is NOT handled here — callers must authorize via the
 * blob_refs/repository layer before exposing bytes.
 */
export interface BlobStore {
  /** The CAS storage key for a digest. */
  blobKey(digest: string): string;

  // ── digest-keyed (immutable CAS) ──────────────────────────────────────────
  exists(digest: string): Promise<boolean>;
  stat(digest: string): Promise<BlobStat | null>;
  /** Full streaming read. */
  get(digest: string): ReadableStream<Uint8Array>;
  /** Range read; [start, end) (Blob.slice semantics). */
  getRange(digest: string, start: number, end?: number): ReadableStream<Uint8Array>;
  /** Read the whole blob into memory (small blobs only — manifests, metadata). */
  getBytes(digest: string): Promise<Uint8Array>;
  /** Hash + dedup + store in-memory data. `knownDigest` may be supplied by callers that already hashed the same bytes. */
  put(
    data: Exclude<BlobData, ReadableStream<Uint8Array>>,
    knownDigest?: string,
  ): Promise<PutResult>;
  /** Hash + dedup + store streaming data without retaining the full payload in memory. */
  putStream(data: ReadableStream<Uint8Array>, expectedDigest?: string): Promise<PutResult>;
  /** GC only — removes bytes from the CAS. */
  delete(digest: string): Promise<void>;
  presignGet(digest: string, expiresIn?: number): string;
  publicPresignGet(digest: string, expiresIn?: number): string | null;

  // ── raw-key (staging) ─────────────────────────────────────────────────────
  putAtKey(key: string, data: Exclude<BlobData, ReadableStream<Uint8Array>>): Promise<void>;
  readKey(key: string): ReadableStream<Uint8Array>;
  bytesAtKey(key: string): Promise<Uint8Array>;
  existsKey(key: string): Promise<boolean>;
  statKey(key: string): Promise<BlobStat | null>;
  deleteKey(key: string): Promise<void>;
  /** Stream data to a staging key without buffering the full payload in memory. */
  putStreamAtKey(key: string, data: ReadableStream<Uint8Array>): Promise<void>;
  /** Promote a staging key into the CAS under the given (already verified) digest. */
  promoteToBlob(stagingKey: string, digest: string): Promise<void>;
  presignPutKey(key: string, expiresIn?: number): string;
}
