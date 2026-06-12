import { z } from "@hootifactory/core";

/**
 * Shared `multipart/form-data` reader for registry plugins.
 *
 * Several formats accept binary uploads (`.rpm`, `.nupkg`, SwiftPM source
 * archives, …) that must be preserved byte-for-byte, so they can not use
 * `req.formData()` (which would re-encode binary parts). Each of those packages
 * used to ship its own near-identical parser; this module hoists one correct
 * implementation. Callers pick the part-selection strategy via {@link
 * MultipartFilePredicate} so the small behavioural differences (first part with
 * a content-disposition vs. a named file part) stay explicit at the call site.
 */

const encoder = new TextEncoder();
const CRLF = encoder.encode("\r\n");
const HEADER_END = encoder.encode("\r\n\r\n");

/** A `content-type` whose value carries a multipart boundary parameter. */
export const MultipartContentTypeSchema = z
  .string()
  .max(512)
  .refine((value) => multipartBoundary(value) != null, "multipart boundary is required");

/** Extract the `boundary` parameter from a multipart `content-type` value. */
export function multipartBoundary(contentType: string): string | null {
  const boundary = contentType.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  return boundary?.[1] ?? boundary?.[2]?.trim() ?? null;
}

/** A single parsed multipart part. `bytes` is a view into the original body. */
export interface MultipartPart {
  /** The `name` form-field parameter, or null when absent. */
  name: string | null;
  /** The `filename` parameter, present only when the part declares one. */
  filename?: string;
  /** The raw (not lowercased) header block of this part. */
  headers: string;
  /** The part body, byte-for-byte. */
  bytes: Uint8Array;
}

/**
 * Predicate deciding whether a part is the uploaded file. Receives the part's
 * **lowercased** header block.
 */
export type MultipartFilePredicate = (lowercasedHeaders: string) => boolean;

/** Any part that carries a `content-disposition` header (the first one wins). */
export const anyContentDispositionPart: MultipartFilePredicate = (headers) =>
  headers.includes("content-disposition:");

/**
 * A part whose disposition declares a `filename=`, or whose field `name=` is one
 * of `fieldNames` (default `file`/`package`). Plain text fields are rejected, so
 * a leading `name="meta"` field never masquerades as the uploaded artifact.
 */
export function namedFilePart(
  fieldNames: readonly string[] = ["file", "package"],
): MultipartFilePredicate {
  const names = new Set(fieldNames.map((name) => name.toLowerCase()));
  return (headers) => {
    const disposition = headers
      .split("\r\n")
      .find((line) => line.startsWith("content-disposition:"));
    if (!disposition) return false;
    if (/;\s*filename\s*=/.test(disposition)) return true;
    const match = /;\s*name\s*=\s*(?:"([^"]*)"|([^;\s]+))/.exec(disposition);
    const name = (match?.[1] ?? match?.[2])?.trim();
    return name !== undefined && names.has(name);
  };
}

function contentDispositionParam(headers: string, param: string): string | undefined {
  const disposition = headers
    .split("\r\n")
    .find((line) => line.toLowerCase().startsWith("content-disposition:"));
  if (!disposition) return undefined;
  const match = new RegExp(`;\\s*${param}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(disposition);
  return match?.[1] ?? match?.[2];
}

/**
 * Parse every part out of a multipart body. Returns `null` when the body is
 * malformed (callers map that to a 400). `bytes` views the original buffer, so
 * the caller must keep `body` alive while using the result.
 */
export function parseMultipartParts(contentType: string, body: Uint8Array): MultipartPart[] | null {
  const boundary = multipartBoundary(contentType);
  if (!boundary) return null;

  const searchable = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const marker = encoder.encode(`--${boundary}`);
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  const decoder = new TextDecoder();
  const parts: MultipartPart[] = [];

  let cursor = searchable.indexOf(marker);
  if (cursor < 0) return null;

  while (cursor >= 0) {
    cursor += marker.length;
    // A trailing "--" marks the closing boundary.
    if (body[cursor] === 45 && body[cursor + 1] === 45) break;
    // The boundary is followed by CRLF before the part headers.
    if (searchable.indexOf(CRLF, cursor) !== cursor) return null;
    cursor += CRLF.length;

    const headerEnd = searchable.indexOf(HEADER_END, cursor);
    if (headerEnd < 0) return null;
    const headers = decoder.decode(body.subarray(cursor, headerEnd));
    const dataStart = headerEnd + HEADER_END.length;
    const next = searchable.indexOf(delimiter, dataStart);
    if (next < 0) return null;

    const filename = contentDispositionParam(headers, "filename");
    parts.push({
      name: contentDispositionParam(headers, "name") ?? null,
      headers,
      bytes: body.subarray(dataStart, next),
      ...(filename !== undefined ? { filename } : {}),
    });
    // Re-enter at the start of the following `--boundary` marker.
    cursor = next + CRLF.length;
  }

  return parts;
}

/**
 * Extract the first file part (and its filename, when present) from a multipart
 * body, skipping any preceding non-file fields. `isFilePart` defaults to {@link
 * anyContentDispositionPart}. Returns `null` when the body is malformed or has
 * no matching part.
 */
export function extractMultipartFilePart(
  contentType: string,
  body: Uint8Array,
  opts: { isFilePart?: MultipartFilePredicate } = {},
): { bytes: Uint8Array; filename?: string } | null {
  const parts = parseMultipartParts(contentType, body);
  if (!parts) return null;
  const isFilePart = opts.isFilePart ?? anyContentDispositionPart;
  const part = parts.find((candidate) => isFilePart(candidate.headers.toLowerCase()));
  if (!part) return null;
  return part.filename !== undefined
    ? { bytes: part.bytes, filename: part.filename }
    : { bytes: part.bytes };
}

/**
 * Extract the bytes of the first file part. Convenience wrapper over {@link
 * extractMultipartFilePart} for callers that don't need the filename.
 */
export function extractMultipartFile(
  contentType: string,
  body: Uint8Array,
  opts: { isFilePart?: MultipartFilePredicate } = {},
): Uint8Array | null {
  return extractMultipartFilePart(contentType, body, opts)?.bytes ?? null;
}
