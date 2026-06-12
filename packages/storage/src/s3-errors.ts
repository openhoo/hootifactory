import { z } from "@hootifactory/core";

const S3MissingObjectErrorSchema = z.looseObject({
  code: z.literal("NoSuchKey"),
});

/**
 * True only for a genuine "object does not exist" S3 error. Bun surfaces these
 * as an S3Error with code "NoSuchKey". Any other failure (auth, network,
 * missing bucket → "UnknownError"/"NoSuchBucket", etc.) must NOT be treated as
 * "blob absent", or transient/config faults silently look like data loss.
 */
export function isObjectMissing(err: unknown): boolean {
  return S3MissingObjectErrorSchema.safeParse(err).success;
}
