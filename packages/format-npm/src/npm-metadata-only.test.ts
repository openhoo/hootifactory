import { describe, expect, test } from "bun:test";
import { buildNpmMetadataOnlyVersionPatch } from "./npm-metadata-only";

describe("npm metadata-only publish helpers", () => {
  test("keeps no-op metadata publishes separate from metadata patches", () => {
    expect(
      buildNpmMetadataOnlyVersionPatch({
        packageName: "pkg",
        version: "1.0.0",
        manifest: { name: "pkg", version: "1.0.0" },
        liveMetadata: {
          manifest: { name: "pkg", version: "1.0.0", description: "current" },
        },
      }),
    ).toEqual({ ok: true, version: "1.0.0" });
  });

  test("validates metadata-only manifest identity against the URL package", () => {
    expect(
      buildNpmMetadataOnlyVersionPatch({
        packageName: "pkg",
        version: "1.0.0",
        manifest: { name: "other", version: "1.0.0" },
        liveMetadata: null,
      }),
    ).toEqual({
      ok: false,
      error: "version manifest name does not match URL",
      status: 400,
    });

    expect(
      buildNpmMetadataOnlyVersionPatch({
        packageName: "pkg",
        version: "1.0.0",
        manifest: { name: "pkg", version: "2.0.0" },
        liveMetadata: null,
      }),
    ).toEqual({
      ok: false,
      error: "version manifest version does not match version key",
      status: 400,
    });
  });

  test("builds deprecation patches without dropping existing metadata", () => {
    expect(
      buildNpmMetadataOnlyVersionPatch({
        packageName: "@scope/pkg",
        version: "1.0.0",
        manifest: { deprecated: "use 2.x" },
        liveMetadata: {
          dist: { filename: "pkg-1.0.0.tgz" },
          manifest: {
            name: "@scope/pkg",
            version: "1.0.0",
            description: "current",
            dist: { shasum: "abc" },
          },
        },
      }),
    ).toEqual({
      ok: true,
      version: "1.0.0",
      metadata: {
        dist: { filename: "pkg-1.0.0.tgz" },
        manifest: {
          name: "@scope/pkg",
          version: "1.0.0",
          description: "current",
          dist: { shasum: "abc" },
          deprecated: "use 2.x",
        },
      },
    });
  });

  test("normalizes malformed stored metadata when applying deprecations", () => {
    expect(
      buildNpmMetadataOnlyVersionPatch({
        packageName: "pkg",
        version: "1.0.0",
        manifest: { deprecated: "" },
        liveMetadata: "not metadata",
      }),
    ).toEqual({
      ok: true,
      version: "1.0.0",
      metadata: {
        manifest: {
          name: "pkg",
          version: "1.0.0",
          deprecated: "",
        },
      },
    });
  });
});
