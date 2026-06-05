import { describe, expect, test } from "bun:test";
import { extractMultipartFile, multipartBoundary } from "./rpm-multipart";

const BOUNDARY = "----rpmboundary";

function part(headers: string[], body: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(`--${BOUNDARY}\r\n${headers.join("\r\n")}\r\n\r\n`);
  return new Uint8Array([...head, ...body, ...new TextEncoder().encode("\r\n")]);
}

function multipart(...parts: Uint8Array[]): Uint8Array {
  const closing = new TextEncoder().encode(`--${BOUNDARY}--\r\n`);
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total + closing.length);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  out.set(closing, off);
  return out;
}

const contentType = `multipart/form-data; boundary=${BOUNDARY}`;

describe("multipart boundary parsing", () => {
  test("extracts an unquoted boundary token", () => {
    expect(multipartBoundary(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(BOUNDARY);
  });

  test("extracts a quoted boundary token", () => {
    expect(multipartBoundary(`multipart/form-data; boundary="${BOUNDARY}"`)).toBe(BOUNDARY);
  });

  test("returns null when no boundary is present", () => {
    expect(multipartBoundary("multipart/form-data")).toBeNull();
  });
});

describe("extractMultipartFile", () => {
  const fileBytes = new Uint8Array([0xed, 0xab, 0xee, 0xdb, 1, 2, 3]);

  test("returns the bytes of a single file part", () => {
    const body = multipart(
      part(['content-disposition: form-data; name="file"; filename="x.rpm"'], fileBytes),
    );
    const got = extractMultipartFile(contentType, body);
    expect(got).not.toBeNull();
    expect(Buffer.from(got as Uint8Array).equals(Buffer.from(fileBytes))).toBe(true);
  });

  test("skips a leading plain text field and returns the real file part", () => {
    // Regression: a non-file field before the file part must NOT be returned.
    const body = multipart(
      part(['content-disposition: form-data; name="meta"'], new TextEncoder().encode("somevalue")),
      part(['content-disposition: form-data; name="file"; filename="x.rpm"'], fileBytes),
    );
    const got = extractMultipartFile(contentType, body);
    expect(got).not.toBeNull();
    expect(Buffer.from(got as Uint8Array).equals(Buffer.from(fileBytes))).toBe(true);
    // It must NOT be the text field bytes.
    expect(new TextDecoder().decode(got as Uint8Array)).not.toBe("somevalue");
  });

  test('treats a name="package" field with no filename as the file part', () => {
    const body = multipart(part(['content-disposition: form-data; name="package"'], fileBytes));
    const got = extractMultipartFile(contentType, body);
    expect(Buffer.from(got as Uint8Array).equals(Buffer.from(fileBytes))).toBe(true);
  });

  test("returns null when only non-file fields are present", () => {
    const body = multipart(
      part(['content-disposition: form-data; name="meta"'], new TextEncoder().encode("a")),
      part(['content-disposition: form-data; name="other"'], new TextEncoder().encode("b")),
    );
    expect(extractMultipartFile(contentType, body)).toBeNull();
  });

  test("returns null for a content-type without a boundary", () => {
    expect(extractMultipartFile("multipart/form-data", new Uint8Array([1, 2]))).toBeNull();
  });
});
