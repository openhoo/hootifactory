import { describe, expect, test } from "bun:test";
import { multipartBoundary, parseMultipartParts } from "./scoop-publish";
import {
  buildScoopAppManifest,
  buildScoopVersionMeta,
  isValidScoopAppName,
  isValidScoopVersion,
  parseScoopVersionMeta,
  ScoopFilenameSchema,
  ScoopPublishManifestSchema,
} from "./scoop-validation";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);

describe("Scoop validation", () => {
  test("accepts app names with the documented character set and rejects others", () => {
    expect(isValidScoopAppName("7zip")).toBe(true);
    expect(isValidScoopAppName("my.app_name-1")).toBe(true);
    expect(isValidScoopAppName("bad/name")).toBe(false);
    expect(isValidScoopAppName("../escape")).toBe(false);
    expect(isValidScoopAppName("bad name")).toBe(false);
    expect(isValidScoopAppName("")).toBe(false);
  });

  test("accepts permissive Scoop versions and rejects path-y ones", () => {
    expect(isValidScoopVersion("1.2.3")).toBe(true);
    expect(isValidScoopVersion("2024.01-beta+build")).toBe(true);
    expect(isValidScoopVersion("v1.0")).toBe(true);
    expect(isValidScoopVersion("1/2")).toBe(false);
    expect(isValidScoopVersion("1 2")).toBe(false);
  });

  test("filename schema rejects traversal and unknown extensions", () => {
    expect(ScoopFilenameSchema.safeParse("app-1.2.3.zip").success).toBe(true);
    expect(ScoopFilenameSchema.safeParse("app.exe").success).toBe(true);
    expect(ScoopFilenameSchema.safeParse("sub/app.zip").success).toBe(false);
    expect(ScoopFilenameSchema.safeParse("..\\app.zip").success).toBe(false);
    expect(ScoopFilenameSchema.safeParse("app.txt").success).toBe(false);
  });

  test("publish manifest schema requires a version and accepts a bin-only arch override", () => {
    expect(ScoopPublishManifestSchema.safeParse({ version: "1.0.0" }).success).toBe(true);
    expect(ScoopPublishManifestSchema.safeParse({}).success).toBe(false);
    const parsed = ScoopPublishManifestSchema.safeParse({
      version: "1.0.0",
      description: "demo",
      bin: "demo.exe",
      architecture: { "64bit": { bin: ["demo.exe"] } },
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects a publisher-supplied arch-level url/hash (no integrity bypass)", () => {
    // 64-bit Scoop prefers the arch-specific url/hash over the top-level pair, so an
    // arch-level url/hash would let a write-authorized publisher point clients at an
    // attacker download with an attacker hash, bypassing the hosted/scanned blob.
    const injected = ScoopPublishManifestSchema.safeParse({
      version: "1.0.0",
      architecture: {
        "64bit": {
          bin: "x.exe",
          url: "https://evil.example/malware.zip",
          hash: `sha256:${"b".repeat(64)}`,
        },
      },
    });
    expect(injected.success).toBe(false);
    // Other dangerous arch keys are likewise rejected, not silently persisted.
    for (const key of ["autoupdate", "installer", "persist", "shortcuts"]) {
      const probe = ScoopPublishManifestSchema.safeParse({
        version: "1.0.0",
        architecture: { "64bit": { [key]: { foo: "bar" } } },
      });
      expect(probe.success).toBe(false);
    }
    // Unknown arch keys are rejected too (only Scoop's recognized arches survive).
    expect(
      ScoopPublishManifestSchema.safeParse({
        version: "1.0.0",
        architecture: { ia64: { bin: "x.exe" } },
      }).success,
    ).toBe(false);
  });

  test("buildScoopVersionMeta + buildScoopAppManifest round-trip computed url/hash", () => {
    const meta = buildScoopVersionMeta(
      ScoopPublishManifestSchema.parse({
        version: "1.2.3",
        description: "demo app",
        homepage: "https://example.test",
        license: "MIT",
        bin: "demo.exe",
        architecture: { "64bit": { bin: ["demo.exe"] } },
      }),
      { digest: DIGEST, sha256: HEX, filename: "demo-1.2.3.zip" },
    );
    expect(meta.blobDigest).toBe(DIGEST);
    expect(meta.sha256).toBe(HEX);
    expect(meta.filename).toBe("demo-1.2.3.zip");
    // The stored metadata must NOT carry url/hash — those are derived at read time.
    expect("url" in meta).toBe(false);
    expect("hash" in meta).toBe(false);

    expect(parseScoopVersionMeta(meta)).not.toBeNull();

    const manifest = buildScoopAppManifest(
      meta,
      "https://reg.test/scoop/private/download/demo/1.2.3/demo-1.2.3.zip",
    );
    expect(manifest).toEqual({
      version: "1.2.3",
      description: "demo app",
      homepage: "https://example.test",
      license: "MIT",
      bin: "demo.exe",
      architecture: { "64bit": { bin: ["demo.exe"] } },
      url: "https://reg.test/scoop/private/download/demo/1.2.3/demo-1.2.3.zip",
      hash: HEX,
    });
  });

  test("parseScoopVersionMeta rejects malformed metadata", () => {
    expect(parseScoopVersionMeta(null)).toBeNull();
    expect(parseScoopVersionMeta({ version: "1.0.0" })).toBeNull();
    expect(
      parseScoopVersionMeta({
        version: "1.0.0",
        blobDigest: "nope",
        sha256: HEX,
        filename: "a.zip",
      }),
    ).toBeNull();
  });
});

describe("Scoop multipart parsing", () => {
  test("extracts the boundary from a content-type header", () => {
    expect(multipartBoundary("multipart/form-data; boundary=abc123")).toBe("abc123");
    expect(multipartBoundary('multipart/form-data; boundary="quoted-b"')).toBe("quoted-b");
    expect(multipartBoundary("application/json")).toBeNull();
  });

  test("splits a body into named parts with filenames", () => {
    const boundary = "BOUND";
    const body = buildMultipartBody(boundary, [
      { name: "manifest", data: new TextEncoder().encode('{"version":"1.0.0"}') },
      {
        name: "artifact",
        filename: "demo-1.0.0.zip",
        data: new Uint8Array([1, 2, 3, 4]),
      },
    ]);
    const parts = parseMultipartParts(boundary, body);
    expect(parts.map((p) => p.name)).toEqual(["manifest", "artifact"]);
    expect(parts[1]?.filename).toBe("demo-1.0.0.zip");
    expect(Array.from(parts[1]?.data ?? [])).toEqual([1, 2, 3, 4]);
    expect(new TextDecoder().decode(parts[0]?.data)).toBe('{"version":"1.0.0"}');
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
