import { describe, expect, test } from "bun:test";
import {
  buildConanFilesResponse,
  ConanFilenameSchema,
  ConanSegmentSchema,
  conanFileScope,
  packageVersionKey,
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
});
