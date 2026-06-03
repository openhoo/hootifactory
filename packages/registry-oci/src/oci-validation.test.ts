import { describe, expect, test } from "bun:test";
import { OCI_MEDIA_TYPES } from "@hootifactory/types";
import {
  acceptsMediaType,
  manifestMediaType,
  parseBlobRange,
  parseManifestRaw,
  parseReference,
  validateContentRange,
  validateManifest,
} from "./oci-validation";

describe("OCI validation helpers", () => {
  test("parses manifest references into digest and tag variants", () => {
    expect(
      parseReference("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).toEqual({
      kind: "digest",
      value: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(parseReference("latest")).toEqual({ kind: "tag", value: "latest" });
    expect(() => parseReference("sha256:bad")).toThrow();
  });

  test("matches Accept header media ranges without accepting q=0 entries", () => {
    expect(acceptsMediaType(null, OCI_MEDIA_TYPES.manifestV1)).toBe(true);
    expect(acceptsMediaType(OCI_MEDIA_TYPES.manifestV1, OCI_MEDIA_TYPES.manifestV1)).toBe(true);
    expect(acceptsMediaType("application/*", OCI_MEDIA_TYPES.manifestV1)).toBe(true);
    expect(acceptsMediaType("*/*", OCI_MEDIA_TYPES.manifestV1)).toBe(true);
    expect(acceptsMediaType(OCI_MEDIA_TYPES.imageIndexV1, OCI_MEDIA_TYPES.manifestV1)).toBe(false);
    expect(
      acceptsMediaType(
        `${OCI_MEDIA_TYPES.imageIndexV1}; q=0, ${OCI_MEDIA_TYPES.manifestV1}; q=0.5`,
        OCI_MEDIA_TYPES.manifestV1,
      ),
    ).toBe(true);
    expect(acceptsMediaType(`${OCI_MEDIA_TYPES.manifestV1}; q=0`, OCI_MEDIA_TYPES.manifestV1)).toBe(
      false,
    );
  });

  test("normalizes and validates blob byte ranges", () => {
    expect(parseBlobRange(null, 10)).toBeNull();
    expect(parseBlobRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseBlobRange("bytes=7-", 10)).toEqual({ start: 7, end: 9 });
    expect(parseBlobRange("bytes=-4", 10)).toEqual({ start: 6, end: 9 });
    expect(() => parseBlobRange("bytes=10-11", 10)).toThrow();
    expect(() => parseBlobRange("bytes=1-2,3-4", 10)).toThrow();
  });

  test("validates content-range against the expected upload offset", () => {
    const request = new Request("https://registry.test/upload", {
      headers: { "content-range": "bytes 3-5/*" },
    });

    expect(() => validateContentRange(request, 3, 3)).not.toThrow();
    expect(() => validateContentRange(request, 0, 3)).toThrow();
    expect(() => validateContentRange(request, 3, 0)).toThrow();
  });

  test("checks image manifest media type and required descriptors", () => {
    const manifest: Record<string, unknown> = {
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.manifestV1,
      config: {
        mediaType: OCI_MEDIA_TYPES.configV1,
        digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        size: 2,
      },
      layers: [],
    };
    const request = new Request("https://registry.test/manifest", {
      headers: { "content-type": `${OCI_MEDIA_TYPES.manifestV1}; charset=utf-8` },
    });

    const mediaType = manifestMediaType(request, manifest);
    expect(mediaType).toBe(OCI_MEDIA_TYPES.manifestV1);
    expect(() => validateManifest(manifest, mediaType)).not.toThrow();
    expect(() => validateManifest({ ...manifest, layers: undefined }, mediaType)).toThrow();
  });

  test("parses stored manifest JSON as an object or falls back for referrer metadata", () => {
    expect(parseManifestRaw(JSON.stringify({ schemaVersion: 2, artifactType: "test" }))).toEqual({
      schemaVersion: 2,
      artifactType: "test",
    });
    expect(parseManifestRaw("not json")).toEqual({ schemaVersion: 2 });
    expect(parseManifestRaw("[]")).toEqual({ schemaVersion: 2 });
  });
});
