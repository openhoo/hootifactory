export * from "./digest";
export { S3BlobStore, type S3BlobStoreOptions } from "./s3-blob-store";
export * from "./types";

import { S3BlobStore, type S3BlobStoreOptions } from "./s3-blob-store";

/**
 * Build a blob store from explicit options. Every field falls back to env, so
 * `createBlobStore()` matches the process-wide default while tests (or alternate
 * deployments) can inject an isolated config without mutating `process.env`.
 */
export function createBlobStore(opts: S3BlobStoreOptions = {}): S3BlobStore {
  return new S3BlobStore(opts);
}

/** Default process-wide blob store, configured from env. */
export const blobStore = createBlobStore();
