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

  const marker = new TextEncoder().encode(`--${boundary}`);
  const delimiter = new TextEncoder().encode(`\r\n--${boundary}`);
  let cursor = indexOfBytes(body, marker);
  const decoder = new TextDecoder();

  while (cursor >= 0) {
    cursor += marker.length;
    if (body[cursor] === 45 && body[cursor + 1] === 45) return null;
    if (indexOfBytes(body, CRLF, cursor) !== cursor) return null;
    cursor += CRLF.length;

    const headerEnd = indexOfBytes(body, HEADER_END, cursor);
    if (headerEnd < 0) return null;
    const headers = decoder.decode(body.subarray(cursor, headerEnd)).toLowerCase();
    const dataStart = headerEnd + HEADER_END.length;
    const next = indexOfBytes(body, delimiter, dataStart);
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

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from;
  for (let i = from; i <= haystack.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}
