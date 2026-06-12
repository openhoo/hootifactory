import {
  namedFilePart,
  extractMultipartFile as sdkFile,
  extractMultipartFilePart as sdkPart,
} from "@hootifactory/registry";

export { MultipartContentTypeSchema, multipartBoundary } from "@hootifactory/registry";

/**
 * An RPM upload's file part is the one whose Content-Disposition declares a
 * `filename=`, or whose field name is `file`/`package` — a plain text form field
 * (e.g. a leading `name="meta"`) is skipped so it never masquerades as the `.rpm`.
 */
const isFilePart = namedFilePart();

export function extractMultipartFile(contentType: string, body: Uint8Array): Uint8Array | null {
  return sdkFile(contentType, body, { isFilePart });
}

export function extractMultipartFilePart(
  contentType: string,
  body: Uint8Array,
): { bytes: Uint8Array; filename?: string } | null {
  return sdkPart(contentType, body, { isFilePart });
}
