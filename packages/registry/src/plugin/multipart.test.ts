import { describe, expect, test } from "bun:test";
import {
  anyContentDispositionPart,
  extractMultipartFile,
  extractMultipartFilePart,
  MultipartContentTypeSchema,
  multipartBoundary,
  namedFilePart,
  parseMultipartParts,
} from "./multipart";

const BOUNDARY = "X-BOUNDARY-123";
const CT = `multipart/form-data; boundary=${BOUNDARY}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface PartSpec {
  disposition: string;
  body: string | Uint8Array;
}

/** Build a well-formed multipart/form-data body from part specs. */
function buildBody(parts: PartSpec[], boundary = BOUNDARY): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(encoder.encode(`--${boundary}\r\n${part.disposition}\r\n\r\n`));
    chunks.push(typeof part.body === "string" ? encoder.encode(part.body) : part.body);
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe("multipartBoundary", () => {
  test("parses unquoted, quoted, and rejects missing", () => {
    expect(multipartBoundary(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(BOUNDARY);
    expect(multipartBoundary(`multipart/form-data; boundary="${BOUNDARY}"`)).toBe(BOUNDARY);
    expect(multipartBoundary("application/json")).toBeNull();
  });
});

describe("MultipartContentTypeSchema", () => {
  test("accepts a boundary-bearing content type and rejects one without", () => {
    expect(MultipartContentTypeSchema.safeParse(CT).success).toBe(true);
    expect(MultipartContentTypeSchema.safeParse("text/plain").success).toBe(false);
  });
});

describe("parseMultipartParts", () => {
  test("returns every part with name, filename, and exact bytes", () => {
    const body = buildBody([
      { disposition: 'content-disposition: form-data; name="meta"', body: "hello" },
      {
        disposition: 'content-disposition: form-data; name="file"; filename="pkg.bin"',
        body: new Uint8Array([0, 1, 2, 255]),
      },
    ]);
    const parts = parseMultipartParts(CT, body);
    expect(parts).not.toBeNull();
    expect(parts).toHaveLength(2);
    expect(parts?.[0]?.name).toBe("meta");
    expect(parts?.[0]?.filename).toBeUndefined();
    expect(decoder.decode(parts?.[0]?.bytes)).toBe("hello");
    expect(parts?.[1]?.name).toBe("file");
    expect(parts?.[1]?.filename).toBe("pkg.bin");
    expect(Array.from(parts?.[1]?.bytes ?? [])).toEqual([0, 1, 2, 255]);
  });

  test("returns null for malformed bodies", () => {
    expect(parseMultipartParts("text/plain", new Uint8Array())).toBeNull();
    expect(parseMultipartParts(CT, encoder.encode("no boundary here"))).toBeNull();
    // boundary present but no CRLF / headers / closing delimiter
    expect(parseMultipartParts(CT, encoder.encode(`--${BOUNDARY}xyz`))).toBeNull();
    expect(parseMultipartParts(CT, encoder.encode(`--${BOUNDARY}\r\nno-header-end`))).toBeNull();
  });

  test("handles an empty body (immediate closing boundary)", () => {
    expect(parseMultipartParts(CT, encoder.encode(`--${BOUNDARY}--\r\n`))).toEqual([]);
  });
});

describe("predicates", () => {
  test("anyContentDispositionPart matches any disposition header", () => {
    expect(anyContentDispositionPart("content-disposition: form-data; name=x")).toBe(true);
    expect(anyContentDispositionPart("content-type: text/plain")).toBe(false);
  });

  test("namedFilePart matches filename or configured field names, rejects text fields", () => {
    const isFile = namedFilePart();
    expect(isFile('content-disposition: form-data; name="file"')).toBe(true);
    expect(isFile('content-disposition: form-data; name="package"')).toBe(true);
    expect(isFile('content-disposition: form-data; name="x"; filename="a.bin"')).toBe(true);
    expect(isFile('content-disposition: form-data; name="meta"')).toBe(false);
    expect(isFile("content-type: text/plain")).toBe(false);
    expect(namedFilePart(["artifact"])('content-disposition: form-data; name="artifact"')).toBe(
      true,
    );
  });
});

describe("extractMultipartFilePart / extractMultipartFile", () => {
  test("default predicate returns the first part with a disposition", () => {
    const body = buildBody([
      { disposition: 'content-disposition: form-data; name="meta"', body: "first" },
    ]);
    expect(extractMultipartFile(CT, body)).not.toBeNull();
    expect(decoder.decode(extractMultipartFile(CT, body) ?? undefined)).toBe("first");
  });

  test("namedFilePart skips the leading text field and returns the file part + filename", () => {
    const body = buildBody([
      { disposition: 'content-disposition: form-data; name="meta"', body: "ignored" },
      {
        disposition: 'content-disposition: form-data; name="file"; filename="pkg.rpm"',
        body: "PAYLOAD",
      },
    ]);
    const part = extractMultipartFilePart(CT, body, { isFilePart: namedFilePart() });
    expect(part?.filename).toBe("pkg.rpm");
    expect(decoder.decode(part?.bytes)).toBe("PAYLOAD");
  });

  test("returns null when no part matches or the body is malformed", () => {
    const onlyText = buildBody([
      { disposition: 'content-disposition: form-data; name="meta"', body: "x" },
    ]);
    expect(extractMultipartFilePart(CT, new Uint8Array())).toBeNull();
    expect(extractMultipartFile(CT, onlyText, { isFilePart: namedFilePart() })).toBeNull();
  });
});
