import { describe, expect, test } from "bun:test";
import {
  buildConanFilesResponse,
  ConanFilenameSchema,
  ConanPackageIdSchema,
  ConanRevisionSchema,
  ConanSegmentSchema,
  conanFileScope,
  conanJsonResponse,
  conanSearchPatternToRegExp,
  packageVersionKey,
  parseConanInfo,
  parseConanRevisionMeta,
  recipeVersionKey,
  referenceToPackageName,
} from "./conan-validation";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("conan-validation", () => {
  test("referenceToPackageName builds the canonical name/version@user/channel", () => {
    expect(
      referenceToPackageName({ name: "zlib", version: "1.2.13", user: "acme", channel: "stable" }),
    ).toBe("zlib/1.2.13@acme/stable");
  });

  test("conanFileScope distinguishes recipe and package files", () => {
    expect(
      conanFileScope({
        reference: "zlib/1.2.13@acme/stable",
        rrev: "r1",
        filename: "conanfile.py",
      }),
    ).toBe("zlib/1.2.13@acme/stable#r1/conanfile.py");
    expect(
      conanFileScope({
        reference: "zlib/1.2.13@acme/stable",
        rrev: "r1",
        packageId: "p1",
        prev: "v1",
        filename: "conan_package.tgz",
      }),
    ).toBe("zlib/1.2.13@acme/stable#r1:p1#v1/conan_package.tgz");
  });

  test("version keys keep recipe and package revisions distinct", () => {
    expect(recipeVersionKey("r1")).toBe("r1");
    expect(packageVersionKey("r1", "p1", "v1")).toBe("pkg:r1:p1#v1");
  });

  test("package version key is scoped by recipe revision to avoid collisions", () => {
    // Same package id + package revision under two recipe revisions must not collide.
    expect(packageVersionKey("rrevA", "p1", "v1")).not.toBe(packageVersionKey("rrevB", "p1", "v1"));
  });

  test("segment schema accepts conan names and rejects spaces/slashes", () => {
    expect(ConanSegmentSchema.safeParse("zlib").success).toBe(true);
    expect(ConanSegmentSchema.safeParse("1.2.13+build").success).toBe(true);
    expect(ConanSegmentSchema.safeParse("bad name").success).toBe(false);
    expect(ConanSegmentSchema.safeParse("a/b").success).toBe(false);
  });

  test("filename schema rejects traversal and path separators", () => {
    expect(ConanFilenameSchema.safeParse("conan_package.tgz").success).toBe(true);
    expect(ConanFilenameSchema.safeParse("../etc/passwd").success).toBe(false);
    expect(ConanFilenameSchema.safeParse("a/b.txt").success).toBe(false);
  });

  test("parseConanRevisionMeta validates the stored shape", () => {
    const meta = parseConanRevisionMeta({
      kind: "recipe",
      reference: "zlib/1.2.13@acme/stable",
      rrev: "r1",
      time: "2026-01-01T00:00:00.000Z",
      files: { "conanfile.py": { blobDigest: DIGEST, sizeBytes: 4 } },
    });
    expect(meta?.kind).toBe("recipe");
    expect(meta?.files["conanfile.py"]?.blobDigest).toBe(DIGEST);
    // A missing digest fails validation.
    expect(
      parseConanRevisionMeta({
        kind: "recipe",
        reference: "x",
        rrev: "r1",
        time: "t",
        files: { bad: { sizeBytes: 1 } },
      }),
    ).toBeNull();
  });

  test("buildConanFilesResponse collapses to sorted {name:{}} entries", () => {
    expect(
      buildConanFilesResponse({
        "conanmanifest.txt": { blobDigest: DIGEST, sizeBytes: 2 },
        "conanfile.py": { blobDigest: DIGEST, sizeBytes: 4 },
      }),
    ).toEqual({ files: { "conanfile.py": {}, "conanmanifest.txt": {} } });
  });

  test("conanJsonResponse sets the space-separated JSON content-type + etag", () => {
    const res = conanJsonResponse({ a: 1 });
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.status).toBe(200);
  });

  test("conanSearchPatternToRegExp maps globs and escapes regex metachars", () => {
    const re = conanSearchPatternToRegExp("zlib/*", false);
    expect(re.test("zlib/1.2.13@acme/stable")).toBe(true);
    expect(re.test("zlibng/1.0@acme/stable")).toBe(false);
    // The `.` in the pattern is a literal, not a wildcard.
    const dot = conanSearchPatternToRegExp("a.b", false);
    expect(dot.test("a.b")).toBe(true);
    expect(dot.test("axb")).toBe(false);
    // `?` matches exactly one character.
    const q = conanSearchPatternToRegExp("z?ib", false);
    expect(q.test("zlib")).toBe(true);
    expect(q.test("zllib")).toBe(false);
    // ignoreCase honoured.
    expect(conanSearchPatternToRegExp("ZLIB", true).test("zlib")).toBe(true);
    expect(conanSearchPatternToRegExp("ZLIB", false).test("zlib")).toBe(false);
  });

  test("parseConanInfo extracts settings/options/requires and ignores other sections", () => {
    const text = [
      "[settings]",
      "    arch=x86_64",
      "    build_type=Release",
      "    compiler.version=11",
      "[requires]",
      "    fmt/9.Y.Z",
      "[options]",
      "    shared=False",
      "[full_settings]",
      "    arch=x86_64",
      "    os=Linux",
      "[recipe_hash]",
      "    abc123",
      "",
    ].join("\n");
    expect(parseConanInfo(text)).toEqual({
      settings: { arch: "x86_64", build_type: "Release", "compiler.version": "11" },
      options: { shared: "False" },
      requires: ["fmt/9.Y.Z"],
    });
  });

  test("parseConanInfo returns empty sections for an empty document", () => {
    expect(parseConanInfo("")).toEqual({ settings: {}, options: {}, requires: [] });
  });

  test("revision schema rejects the separators that would let keys collide", () => {
    expect(ConanRevisionSchema.safeParse("rrev1").success).toBe(true);
    // ':' and '#' are the package-version-key separators; a revision must never
    // contain them, or a recipe key could collide with a package key.
    expect(ConanRevisionSchema.safeParse("r:1").success).toBe(false);
    expect(ConanRevisionSchema.safeParse("r#1").success).toBe(false);
    expect(ConanRevisionSchema.safeParse("r 1").success).toBe(false);
    expect(ConanRevisionSchema.safeParse("").success).toBe(false);
    expect(ConanRevisionSchema.safeParse("a".repeat(129)).success).toBe(false);
  });

  test("package-id schema rejects separators, spaces, and empty", () => {
    expect(ConanPackageIdSchema.safeParse("pkgid01").success).toBe(true);
    expect(ConanPackageIdSchema.safeParse("p:1").success).toBe(false);
    expect(ConanPackageIdSchema.safeParse("p#1").success).toBe(false);
    expect(ConanPackageIdSchema.safeParse("p 1").success).toBe(false);
    expect(ConanPackageIdSchema.safeParse("").success).toBe(false);
  });
});
