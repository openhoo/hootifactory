import { describe, expect, test } from "bun:test";
import { multipartBoundary, parseSwiftMultipart } from "./swift-multipart";

const BOUNDARY = "boundary123";

function part(name: string, body: Uint8Array, contentType?: string): Uint8Array {
  const header =
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="${name}"\r\n` +
    (contentType ? `Content-Type: ${contentType}\r\n` : "") +
    "\r\n";
  return new Uint8Array([
    ...new TextEncoder().encode(header),
    ...body,
    ...new TextEncoder().encode("\r\n"),
  ]);
}

function buildBody(parts: Uint8Array[]): Uint8Array {
  const closing = new TextEncoder().encode(`--${BOUNDARY}--\r\n`);
  let length = closing.byteLength;
  for (const p of parts) length += p.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  out.set(closing, offset);
  return out;
}

describe("parseSwiftMultipart", () => {
  test("extracts the boundary from a content-type", () => {
    expect(multipartBoundary(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(BOUNDARY);
    expect(multipartBoundary(`multipart/form-data; boundary="${BOUNDARY}"`)).toBe(BOUNDARY);
    expect(multipartBoundary("application/json")).toBeNull();
  });

  test("parses named parts including binary archive bytes", () => {
    const archive = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x0a, 0x0d, 0x00]);
    const body = buildBody([
      part("source-archive", archive, "application/zip"),
      part(
        "metadata",
        new TextEncoder().encode('{"repositoryURL":"https://x"}'),
        "application/json",
      ),
    ]);

    const parts = parseSwiftMultipart(`multipart/form-data; boundary=${BOUNDARY}`, body);
    expect(parts).not.toBeNull();
    const archivePart = parts?.find((p) => p.name === "source-archive");
    const metadataPart = parts?.find((p) => p.name === "metadata");
    expect(archivePart?.bytes).toEqual(archive);
    expect(new TextDecoder().decode(metadataPart?.bytes)).toBe('{"repositoryURL":"https://x"}');
  });

  test("returns null for a missing boundary", () => {
    expect(parseSwiftMultipart("application/json", new Uint8Array())).toBeNull();
  });

  test("returns null for a body without the opening boundary", () => {
    expect(
      parseSwiftMultipart(
        `multipart/form-data; boundary=${BOUNDARY}`,
        new TextEncoder().encode("not multipart at all"),
      ),
    ).toBeNull();
  });
});
