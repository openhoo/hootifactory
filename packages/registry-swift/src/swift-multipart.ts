/**
 * Minimal `multipart/form-data` reader for the SwiftPM publish request. We can
 * not use `req.formData()` because the source-archive part is binary and must
 * be preserved byte-for-byte to recompute its SHA256 checksum.
 */

const encoder = new TextEncoder();
const CRLF = encoder.encode("\r\n");
const HEADER_END = encoder.encode("\r\n\r\n");

export interface SwiftMultipartPart {
  name: string;
  bytes: Uint8Array;
}

export function multipartBoundary(contentType: string): string | null {
  const match = contentType.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  return match?.[1] ?? match?.[2]?.trim() ?? null;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).indexOf(
    needle,
    from,
  );
}

function parseDispositionName(headerBlock: string): string | null {
  for (const line of headerBlock.split("\r\n")) {
    if (!/^content-disposition:/i.test(line)) continue;
    const match = line.match(/;\s*name=(?:"([^"]*)"|([^;]+))/i);
    const name = match?.[1] ?? match?.[2]?.trim();
    if (name) return name;
  }
  return null;
}

/**
 * Parse all named parts out of a multipart body. Returns `null` when the body
 * is malformed (callers map that to a 400).
 */
export function parseSwiftMultipart(
  contentType: string,
  body: Uint8Array,
): SwiftMultipartPart[] | null {
  const boundary = multipartBoundary(contentType);
  if (!boundary) return null;

  const delimiter = encoder.encode(`--${boundary}`);
  const parts: SwiftMultipartPart[] = [];
  const decoder = new TextDecoder();

  let cursor = indexOf(body, delimiter, 0);
  if (cursor < 0) return null;
  cursor += delimiter.length;

  while (cursor <= body.length) {
    // A trailing "--" marks the closing boundary.
    if (body[cursor] === 45 && body[cursor + 1] === 45) break;
    // The boundary is followed by CRLF before the part headers.
    if (indexOf(body, CRLF, cursor) !== cursor) return null;
    cursor += CRLF.length;

    const headerEnd = indexOf(body, HEADER_END, cursor);
    if (headerEnd < 0) return null;
    const headerBlock = decoder.decode(body.subarray(cursor, headerEnd));
    const dataStart = headerEnd + HEADER_END.length;

    const nextDelimiter = indexOf(body, encoder.encode(`\r\n--${boundary}`), dataStart);
    if (nextDelimiter < 0) return null;

    const name = parseDispositionName(headerBlock);
    if (name) parts.push({ name, bytes: body.subarray(dataStart, nextDelimiter) });

    cursor = nextDelimiter + 2 + delimiter.length;
  }

  return parts;
}
