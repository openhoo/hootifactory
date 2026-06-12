/**
 * Minimal `multipart/form-data` reader for the SwiftPM publish request. We can
 * not use `req.formData()` because the source-archive part is binary and must
 * be preserved byte-for-byte to recompute its SHA256 checksum.
 *
 * This is a thin wrapper over the shared parser in `@hootifactory/registry`; it
 * keeps only the named parts (a SwiftPM part without a `name` is dropped).
 */

import { multipartBoundary, parseMultipartParts } from "@hootifactory/registry";

export { multipartBoundary };

export interface SwiftMultipartPart {
  name: string;
  bytes: Uint8Array;
}

export function parseSwiftMultipart(
  contentType: string,
  body: Uint8Array,
): SwiftMultipartPart[] | null {
  const parts = parseMultipartParts(contentType, body);
  if (!parts) return null;
  return parts.flatMap((p) => (p.name ? [{ name: p.name, bytes: p.bytes }] : []));
}
