import { z } from "@hootifactory/registry";

const CRLF = new TextEncoder().encode("\r\n");
const HEADER_END = new TextEncoder().encode("\r\n\r\n");

export const MultipartContentTypeSchema = z
  .string()
  .max(512)
  .refine((value) => multipartBoundary(value) != null, "multipart boundary is required");

export function extractMultipartFile(contentType: string, body: Uint8Array): Uint8Array | null {
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
    const headers = decoder.decode(body.subarray(cursor, headerEnd)).toLowerCase();
    const dataStart = headerEnd + HEADER_END.length;
    const next = searchableBody.indexOf(delimiter, dataStart);
    if (next < 0) return null;
    if (headers.includes("content-disposition:") && next >= dataStart) {
      return body.subarray(dataStart, next);
    }
    cursor = next + CRLF.length;
  }

  return null;
}

export function multipartBoundary(contentType: string): string | null {
  const boundary = contentType.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  return boundary?.[1] ?? boundary?.[2]?.trim() ?? null;
}
