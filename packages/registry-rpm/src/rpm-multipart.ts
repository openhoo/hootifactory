import { z } from "@hootifactory/registry";

const CRLF = new TextEncoder().encode("\r\n");
const HEADER_END = new TextEncoder().encode("\r\n\r\n");

export const MultipartContentTypeSchema = z
  .string()
  .max(512)
  .refine((value) => multipartBoundary(value) != null, "multipart boundary is required");

export function multipartBoundary(contentType: string): string | null {
  const boundary = contentType.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  return boundary?.[1] ?? boundary?.[2]?.trim() ?? null;
}

/**
 * Decide whether a part's (lowercased) header block names an uploaded file, i.e.
 * its `Content-Disposition` carries a `filename=` parameter, or its field name is
 * one of the conventional package-upload field names (`file`/`package`). A plain
 * text form field (no `filename=`, ordinary `name=`) is NOT a file part — those
 * are skipped so a leading `name="meta"` field never masquerades as the `.rpm`.
 */
function isFilePart(headers: string): boolean {
  const disposition = headers.split("\r\n").find((line) => line.startsWith("content-disposition:"));
  if (!disposition) return false;
  if (/;\s*filename\s*=/.test(disposition)) return true;
  return /;\s*name\s*=\s*"?(?:file|package)"?/.test(disposition);
}

function contentDispositionParam(headers: string, name: string): string | undefined {
  const disposition = headers
    .split("\r\n")
    .find((line) => line.toLowerCase().startsWith("content-disposition:"));
  if (!disposition) return undefined;
  const match = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(disposition);
  return match?.[1] ?? match?.[2];
}

/**
 * Extract the first file part (the one whose Content-Disposition names a file)
 * from a multipart/form-data body, skipping any preceding plain form fields.
 * Returns null if no file part is found.
 */
export function extractMultipartFile(contentType: string, body: Uint8Array): Uint8Array | null {
  return extractMultipartFilePart(contentType, body)?.bytes ?? null;
}

export function extractMultipartFilePart(
  contentType: string,
  body: Uint8Array,
): { bytes: Uint8Array; filename?: string } | null {
  const boundary = multipartBoundary(contentType);
  if (!boundary) return null;

  const searchableBody = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const marker = new TextEncoder().encode(`--${boundary}`);
  const delimiter = new TextEncoder().encode(`\r\n--${boundary}`);
  let cursor = searchableBody.indexOf(marker);
  const decoder = new TextDecoder();

  while (cursor >= 0) {
    cursor += marker.length;
    if (body[cursor] === 45 && body[cursor + 1] === 45) return null;
    if (searchableBody.indexOf(CRLF, cursor) !== cursor) return null;
    cursor += CRLF.length;

    const headerEnd = searchableBody.indexOf(HEADER_END, cursor);
    if (headerEnd < 0) return null;
    const headers = decoder.decode(body.subarray(cursor, headerEnd));
    const dataStart = headerEnd + HEADER_END.length;
    const next = searchableBody.indexOf(delimiter, dataStart);
    if (next < 0) return null;
    if (next >= dataStart && isFilePart(headers.toLowerCase())) {
      return {
        bytes: body.subarray(dataStart, next),
        ...(contentDispositionParam(headers, "filename")
          ? { filename: contentDispositionParam(headers, "filename") }
          : {}),
      };
    }
    // Not a file part (e.g. a plain `name="meta"` text field): keep scanning. The
    // next iteration re-enters at the start of the following `--boundary` marker.
    cursor = next + CRLF.length;
  }

  return null;
}
