export * from "./digest";
export { S3BlobStore, type S3BlobStoreOptions } from "./s3-blob-store";
export * from "./types";

import { S3BlobStore } from "./s3-blob-store";

/** Default process-wide blob store, configured from env. */
export const blobStore = new S3BlobStore();
