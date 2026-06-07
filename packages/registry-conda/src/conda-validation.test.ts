import { describe, expect, test } from "bun:test";
import { multipartBoundary, parseMultipartParts } from "./conda-publish";
import {
  buildCondaRepodataRecord,
  buildCondaVersionMeta,
  CondaFilenameSchema,
  CondaIndexJsonSchema,
  condaFilenameStem,
  condaPackageKind,
  hasCondaArchiveMagic,
  isValidCondaSubdir,
  isValidCondaVersion,
  parseCondaFilename,
  parseCondaVersionMeta,
} from "./conda-validation";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);
const MD5 = "b".repeat(32);

describe("Conda validation", () => {
  test("accepts known subdirs and platform triples, rejects path-y ones", () => {
    expect(isValidCondaSubdir("noarch")).toBe(true);
    expect(isValidCondaSubdir("linux-64")).toBe(true);
    expect(isValidCondaSubdir("osx-arm64")).toBe(true);
    expect(isValidCondaSubdir("win-64")).toBe(true);
    expect(isValidCondaSubdir("linux-aarch64")).toBe(true);
    expect(isValidCondaSubdir("..")).toBe(false);
    expect(isValidCondaSubdir("sub/dir")).toBe(false);
    expect(isValidCondaSubdir("")).toBe(false);
  });

  test("sniffs the declared archive format from the blob's magic bytes", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff]);
    const bzip2 = new Uint8Array([0x42, 0x5a, 0x68, 0x39, 0xff]);
    // `.conda` must be a zip; `.tar.bz2` must be a bzip2 stream.
    expect(hasCondaArchiveMagic("conda", zip)).toBe(true);
    expect(hasCondaArchiveMagic("tarbz2", bzip2)).toBe(true);
    // Wrong magic for the declared kind, or a non-archive payload, is rejected.
    expect(hasCondaArchiveMagic("conda", bzip2)).toBe(false);
    expect(hasCondaArchiveMagic("tarbz2", zip)).toBe(false);
    expect(hasCondaArchiveMagic("conda", new TextEncoder().encode("{}"))).toBe(false);
    expect(hasCondaArchiveMagic("conda", new Uint8Array([0x50, 0x4b]))).toBe(false);
  });

  test("accepts permissive conda versions and rejects path-y ones", () => {
    expect(isValidCondaVersion("1.2.3")).toBe(true);
    expect(isValidCondaVersion("2024.1.0+build")).toBe(true);
    expect(isValidCondaVersion("1.0.0rc1")).toBe(true);
    expect(isValidCondaVersion("1/2")).toBe(false);
    expect(isValidCondaVersion("1 2")).toBe(false);
  });

  test("filename schema requires a .conda or .tar.bz2 extension and no traversal", () => {
    expect(CondaFilenameSchema.safeParse("numpy-1.0-py39_0.conda").success).toBe(true);
    expect(CondaFilenameSchema.safeParse("numpy-1.0-py39_0.tar.bz2").success).toBe(true);
    expect(CondaFilenameSchema.safeParse("numpy-1.0-py39_0.zip").success).toBe(false);
    expect(CondaFilenameSchema.safeParse("sub/numpy-1.0-0.conda").success).toBe(false);
    expect(CondaFilenameSchema.safeParse("..\\numpy.conda").success).toBe(false);
  });

  test("condaPackageKind buckets .conda vs .tar.bz2", () => {
    expect(condaPackageKind("a-1-0.conda")).toBe("conda");
    expect(condaPackageKind("a-1-0.tar.bz2")).toBe("tarbz2");
    expect(condaPackageKind("a-1-0.zip")).toBeNull();
  });

  test("condaFilenameStem strips the package extension", () => {
    expect(condaFilenameStem("numpy-1.0-py39_0.conda")).toBe("numpy-1.0-py39_0");
    expect(condaFilenameStem("numpy-1.0-py39_0.tar.bz2")).toBe("numpy-1.0-py39_0");
  });

  test("parseCondaFilename splits name/version/build on the last two dashes", () => {
    expect(parseCondaFilename("numpy-1.21.0-py39h_0.conda")).toEqual({
      name: "numpy",
      version: "1.21.0",
      build: "py39h_0",
    });
    // A dash-containing package name is preserved.
    expect(parseCondaFilename("ca-certificates-2024.2.2-h0d85af4_0.tar.bz2")).toEqual({
      name: "ca-certificates",
      version: "2024.2.2",
      build: "h0d85af4_0",
    });
    // Too few segments.
    expect(parseCondaFilename("noversion.conda")).toBeNull();
    expect(parseCondaFilename("bad.zip")).toBeNull();
  });

  test("index.json schema requires name/version/build", () => {
    expect(
      CondaIndexJsonSchema.safeParse({ name: "numpy", version: "1.0", build: "0" }).success,
    ).toBe(true);
    expect(CondaIndexJsonSchema.safeParse({ name: "numpy", version: "1.0" }).success).toBe(false);
    const parsed = CondaIndexJsonSchema.safeParse({
      name: "numpy",
      version: "1.0",
      build: "py39_0",
      build_number: 0,
      depends: ["python >=3.9"],
      subdir: "linux-64",
      license: "BSD-3-Clause",
    });
    expect(parsed.success).toBe(true);
  });

  test("buildCondaVersionMeta + buildCondaRepodataRecord round-trip the record", () => {
    const index = CondaIndexJsonSchema.parse({
      name: "numpy",
      version: "1.21.0",
      build: "py39_0",
      build_number: 0,
      depends: ["python >=3.9", "libblas"],
      license: "BSD-3-Clause",
      timestamp: 1535416612069,
    });
    const meta = buildCondaVersionMeta(index, {
      subdir: "linux-64",
      filename: "numpy-1.21.0-py39_0.conda",
      packageKind: "conda",
      digest: DIGEST,
      sha256: HEX,
      md5: MD5,
      size: 1234,
    });
    expect(meta.blobDigest).toBe(DIGEST);
    expect(meta.subdir).toBe("linux-64");
    expect(parseCondaVersionMeta(meta)).not.toBeNull();

    expect(buildCondaRepodataRecord(meta)).toEqual({
      name: "numpy",
      version: "1.21.0",
      build: "py39_0",
      build_number: 0,
      subdir: "linux-64",
      md5: MD5,
      sha256: HEX,
      size: 1234,
      depends: ["python >=3.9", "libblas"],
      license: "BSD-3-Clause",
      timestamp: 1535416612069,
    });
  });

  test("parseCondaVersionMeta rejects malformed metadata", () => {
    expect(parseCondaVersionMeta(null)).toBeNull();
    expect(parseCondaVersionMeta({ subdir: "linux-64" })).toBeNull();
    expect(
      parseCondaVersionMeta({
        index: { name: "a", version: "1", build: "0" },
        subdir: "linux-64",
        filename: "a-1-0.conda",
        packageKind: "conda",
        blobDigest: "nope",
        sha256: HEX,
        md5: MD5,
        size: 1,
      }),
    ).toBeNull();
  });
});

describe("Conda multipart parsing", () => {
  test("extracts the boundary from a content-type header", () => {
    expect(multipartBoundary("multipart/form-data; boundary=abc123")).toBe("abc123");
    expect(multipartBoundary('multipart/form-data; boundary="quoted-b"')).toBe("quoted-b");
    expect(multipartBoundary("application/json")).toBeNull();
  });

  test("splits a body into named parts with filenames", () => {
    const boundary = "BOUND";
    const body = buildMultipartBody(boundary, [
      { name: "index", data: new TextEncoder().encode('{"name":"numpy"}') },
      { name: "artifact", filename: "numpy-1.0-0.conda", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const parts = parseMultipartParts(boundary, body);
    expect(parts.map((p) => p.name)).toEqual(["index", "artifact"]);
    expect(parts[1]?.filename).toBe("numpy-1.0-0.conda");
    expect(Array.from(parts[1]?.data ?? [])).toEqual([1, 2, 3, 4]);
    expect(new TextDecoder().decode(parts[0]?.data)).toBe('{"name":"numpy"}');
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
