import { describe, expect, test } from "bun:test";
import {
  buildGenericIndexEntries,
  buildGenericVersionMeta,
  genericBlobScope,
  isValidGenericPath,
  isValidGenericPrefix,
  normalizeGenericContentType,
  parseGenericVersionMeta,
} from "./generic-validation";

describe("isValidGenericPath", () => {
  test.each([
    "app.bin",
    "releases/1.0/app.tar.gz",
    "a/b/c/d.json",
    "dir/file-with.dots_and-dashes.ext",
  ])("accepts %p", (path) => {
    expect(isValidGenericPath(path)).toBe(true);
  });

  test.each([
    "", // empty
    "/leading", // absolute
    "trailing/", // directory-style
    "a//b", // empty segment
    "../escape", // traversal
    "a/../b", // embedded traversal
    "a/./b", // dot segment
    ".", // lone dot
    "..", // lone dotdot
    "back\\slash", // backslash separator
  ])("rejects %p", (path) => {
    expect(isValidGenericPath(path)).toBe(false);
  });

  test("rejects paths containing ASCII control bytes", () => {
    expect(isValidGenericPath(`with${String.fromCharCode(0)}nul`)).toBe(false);
    expect(isValidGenericPath(`with${String.fromCharCode(7)}bel`)).toBe(false);
    expect(isValidGenericPath(`with${String.fromCharCode(0x7f)}del`)).toBe(false);
  });

  test("rejects an over-long path", () => {
    expect(isValidGenericPath("a".repeat(1025))).toBe(false);
  });
});

describe("isValidGenericPrefix", () => {
  test("accepts the empty (root) prefix", () => {
    expect(isValidGenericPrefix("")).toBe(true);
  });
  test("accepts a valid directory prefix", () => {
    expect(isValidGenericPrefix("docs/api")).toBe(true);
  });
  test("rejects a traversal prefix", () => {
    expect(isValidGenericPrefix("../x")).toBe(false);
  });
});

describe("normalizeGenericContentType", () => {
  test("defaults a missing content-type to octet-stream", () => {
    expect(normalizeGenericContentType(null)).toBe("application/octet-stream");
  });
  test("strips parameters", () => {
    expect(normalizeGenericContentType("text/plain; charset=utf-8")).toBe("text/plain");
  });
  test("preserves a valid media type", () => {
    expect(normalizeGenericContentType("application/wasm")).toBe("application/wasm");
  });
  test("falls back for a garbage value", () => {
    expect(normalizeGenericContentType("not a media type")).toBe("application/octet-stream");
  });
});

describe("metadata round-trip", () => {
  test("buildGenericVersionMeta then parseGenericVersionMeta", () => {
    const meta = buildGenericVersionMeta({
      path: "a/b.bin",
      blobDigest: `sha256:${"a".repeat(64)}`,
      sha256: "a".repeat(64),
      sha512: "b".repeat(128),
      size: 42,
      contentType: "application/octet-stream",
    });
    expect(parseGenericVersionMeta(meta)).toEqual(meta);
  });

  test("parseGenericVersionMeta rejects malformed metadata", () => {
    expect(parseGenericVersionMeta({ path: "a", sha256: "short" })).toBeNull();
    expect(parseGenericVersionMeta(null)).toBeNull();
  });
});

describe("genericBlobScope", () => {
  test("namespaces the path under generic/", () => {
    expect(genericBlobScope("releases/app.bin")).toBe("generic/releases/app.bin");
  });
});

describe("buildGenericIndexEntries", () => {
  const metas = [
    buildGenericVersionMeta({
      path: "docs/readme.md",
      blobDigest: `sha256:${"a".repeat(64)}`,
      sha256: "a".repeat(64),
      sha512: "a".repeat(128),
      size: 1,
      contentType: "text/markdown",
    }),
    buildGenericVersionMeta({
      path: "bin/app",
      blobDigest: `sha256:${"b".repeat(64)}`,
      sha256: "b".repeat(64),
      sha512: "b".repeat(128),
      size: 2,
      contentType: "application/octet-stream",
    }),
  ];

  test("sorts entries by path and projects the listing shape", () => {
    expect(buildGenericIndexEntries(metas, "")).toEqual([
      { path: "bin/app", size: 2, sha256: "b".repeat(64), contentType: "application/octet-stream" },
      { path: "docs/readme.md", size: 1, sha256: "a".repeat(64), contentType: "text/markdown" },
    ]);
  });

  test("filters by directory prefix (with and without a trailing slash)", () => {
    expect(buildGenericIndexEntries(metas, "docs").map((e) => e.path)).toEqual(["docs/readme.md"]);
    expect(buildGenericIndexEntries(metas, "docs/").map((e) => e.path)).toEqual(["docs/readme.md"]);
    expect(buildGenericIndexEntries(metas, "bin").map((e) => e.path)).toEqual(["bin/app"]);
  });

  test("a prefix that is a path-substring but not a directory does not match", () => {
    // `do` is a prefix of `docs/...` as a string but not a directory boundary.
    expect(buildGenericIndexEntries(metas, "do")).toEqual([]);
  });
});
