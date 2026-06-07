import { describe, expect, test } from "bun:test";
import { multipartBoundary, parseMultipartParts } from "./opam-publish";
import {
  buildOpamVersionMeta,
  isValidOpamPackageName,
  isValidOpamVersion,
  OpamArchiveFilenameSchema,
  OpamPublishManifestSchema,
  opamArchiveMediaType,
  parseOpamVersionMeta,
} from "./opam-validation";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);

describe("opam validation", () => {
  test("accepts package names with the documented character set and rejects others", () => {
    expect(isValidOpamPackageName("dune")).toBe(true);
    expect(isValidOpamPackageName("ppx_deriving")).toBe(true);
    expect(isValidOpamPackageName("lwt-react")).toBe(true);
    // A `.` is forbidden: it separates name from version in `<name>.<version>`.
    expect(isValidOpamPackageName("my.pkg")).toBe(false);
    expect(isValidOpamPackageName("bad/name")).toBe(false);
    expect(isValidOpamPackageName("../escape")).toBe(false);
    expect(isValidOpamPackageName("-leading")).toBe(false);
    expect(isValidOpamPackageName("")).toBe(false);
  });

  test("accepts permissive opam versions and rejects path-y ones", () => {
    expect(isValidOpamVersion("1.2.3")).toBe(true);
    expect(isValidOpamVersion("0.99.1+dev")).toBe(true);
    expect(isValidOpamVersion("1.0~beta1")).toBe(true);
    expect(isValidOpamVersion("1/2")).toBe(false);
    expect(isValidOpamVersion("1 2")).toBe(false);
    expect(isValidOpamVersion("")).toBe(false);
  });

  test("archive filename schema rejects traversal and unknown extensions", () => {
    expect(OpamArchiveFilenameSchema.safeParse("pkg-1.2.3.tar.gz").success).toBe(true);
    expect(OpamArchiveFilenameSchema.safeParse("pkg-1.2.3.tbz").success).toBe(true);
    expect(OpamArchiveFilenameSchema.safeParse("pkg.zip").success).toBe(true);
    expect(OpamArchiveFilenameSchema.safeParse("sub/pkg.tar.gz").success).toBe(false);
    expect(OpamArchiveFilenameSchema.safeParse("..\\pkg.tar.gz").success).toBe(false);
    expect(OpamArchiveFilenameSchema.safeParse("pkg.exe").success).toBe(false);
  });

  test("publish manifest schema requires name + version and accepts depends", () => {
    expect(OpamPublishManifestSchema.safeParse({ name: "dune", version: "3.0.0" }).success).toBe(
      true,
    );
    expect(OpamPublishManifestSchema.safeParse({ version: "1.0.0" }).success).toBe(false);
    expect(OpamPublishManifestSchema.safeParse({ name: "dune" }).success).toBe(false);
    const parsed = OpamPublishManifestSchema.safeParse({
      name: "lwt",
      version: "5.6.1",
      synopsis: "Promises and concurrency",
      depends: [{ name: "ocaml", constraint: '>= "4.08"' }, { name: "dune" }],
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects a dependency constraint that could break out of the formula braces", () => {
    const injected = OpamPublishManifestSchema.safeParse({
      name: "lwt",
      version: "5.6.1",
      depends: [{ name: "ocaml", constraint: '>= "4.08" } evil { ' }],
    });
    expect(injected.success).toBe(false);
  });

  test("rejects a dependency constraint with CR/LF that could inject opam lines", () => {
    for (const constraint of ['>= "4.08"\nflags: [ light-uninstall ]', '>= "4.08"\rfoo']) {
      const result = OpamPublishManifestSchema.safeParse({
        name: "lwt",
        version: "5.6.1",
        depends: [{ name: "ocaml", constraint }],
      });
      expect(result.success).toBe(false);
    }
  });

  test("maps archive filenames to their transport media type", () => {
    expect(opamArchiveMediaType("pkg-1.0.tar.gz")).toBe("application/gzip");
    expect(opamArchiveMediaType("pkg-1.0.tgz")).toBe("application/gzip");
    expect(opamArchiveMediaType("pkg-1.0.tar.bz2")).toBe("application/x-bzip2");
    expect(opamArchiveMediaType("pkg-1.0.tbz")).toBe("application/x-bzip2");
    expect(opamArchiveMediaType("pkg-1.0.tar.xz")).toBe("application/x-xz");
    expect(opamArchiveMediaType("pkg-1.0.txz")).toBe("application/x-xz");
    expect(opamArchiveMediaType("pkg-1.0.tar.zst")).toBe("application/zstd");
    expect(opamArchiveMediaType("pkg-1.0.zip")).toBe("application/zip");
    expect(opamArchiveMediaType("pkg-1.0.tar")).toBe("application/x-tar");
    // Case-insensitive, and unknown extensions fall back to octet-stream.
    expect(opamArchiveMediaType("PKG-1.0.ZIP")).toBe("application/zip");
    expect(opamArchiveMediaType("pkg-1.0.bin")).toBe("application/octet-stream");
  });

  test("buildOpamVersionMeta persists descriptive fields + blob coords, no url/checksum", () => {
    const meta = buildOpamVersionMeta(
      OpamPublishManifestSchema.parse({
        name: "lwt",
        version: "5.6.1",
        maintainer: "team@example.test",
        homepage: "https://example.test",
        license: "MIT",
        synopsis: "Promises and concurrency",
        depends: [{ name: "ocaml", constraint: '>= "4.08"' }],
      }),
      { digest: DIGEST, sha256: HEX, filename: "lwt-5.6.1.tar.gz" },
    );
    expect(meta.blobDigest).toBe(DIGEST);
    expect(meta.sha256).toBe(HEX);
    expect(meta.filename).toBe("lwt-5.6.1.tar.gz");
    expect("url" in meta).toBe(false);
    expect("checksum" in meta).toBe(false);
    expect(parseOpamVersionMeta(meta)).not.toBeNull();
  });

  test("parseOpamVersionMeta rejects malformed metadata", () => {
    expect(parseOpamVersionMeta(null)).toBeNull();
    expect(parseOpamVersionMeta({ name: "lwt", version: "1.0.0" })).toBeNull();
    expect(
      parseOpamVersionMeta({
        name: "lwt",
        version: "1.0.0",
        blobDigest: "nope",
        sha256: HEX,
        filename: "a.tar.gz",
      }),
    ).toBeNull();
  });
});

describe("opam multipart parsing", () => {
  test("extracts the boundary from a content-type header", () => {
    expect(multipartBoundary("multipart/form-data; boundary=abc123")).toBe("abc123");
    expect(multipartBoundary('multipart/form-data; boundary="quoted-b"')).toBe("quoted-b");
    expect(multipartBoundary("application/json")).toBeNull();
  });

  test("splits a body into named parts with filenames", () => {
    const boundary = "BOUND";
    const body = buildMultipartBody(boundary, [
      { name: "manifest", data: new TextEncoder().encode('{"name":"lwt","version":"5.6.1"}') },
      { name: "archive", filename: "lwt-5.6.1.tar.gz", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const parts = parseMultipartParts(boundary, body);
    expect(parts.map((p) => p.name)).toEqual(["manifest", "archive"]);
    expect(parts[1]?.filename).toBe("lwt-5.6.1.tar.gz");
    expect(Array.from(parts[1]?.data ?? [])).toEqual([1, 2, 3, 4]);
    expect(new TextDecoder().decode(parts[0]?.data)).toBe('{"name":"lwt","version":"5.6.1"}');
  });
});

interface MultipartField {
  name: string;
  filename?: string;
  data: Uint8Array;
}

export function buildMultipartBody(boundary: string, fields: MultipartField[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const enc = (s: string) => new TextEncoder().encode(s);
  for (const field of fields) {
    const disposition = field.filename
      ? `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"`
      : `Content-Disposition: form-data; name="${field.name}"`;
    chunks.push(enc(`--${boundary}\r\n${disposition}\r\n\r\n`));
    chunks.push(field.data);
    chunks.push(enc("\r\n"));
  }
  chunks.push(enc(`--${boundary}--\r\n`));
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
