import { describe, expect, test } from "bun:test";
import {
  classifierForKind,
  dirForKind,
  isValidOsgiVersion,
  isValidSymbolicName,
  JarFilenameSchema,
  jarFilename,
  p2JarScope,
  parseP2VersionMeta,
} from "./p2-validation";

describe("symbolic name + version validation", () => {
  test("accepts well-formed OSGi symbolic names", () => {
    expect(isValidSymbolicName("org.example.bundle")).toBe(true);
    expect(isValidSymbolicName("a-b_c.d")).toBe(true);
  });
  test("rejects names with spaces or path separators", () => {
    expect(isValidSymbolicName("bad name")).toBe(false);
    expect(isValidSymbolicName("a/b")).toBe(false);
  });
  test("accepts OSGi versions with an optional qualifier", () => {
    expect(isValidOsgiVersion("1")).toBe(true);
    expect(isValidOsgiVersion("1.2")).toBe(true);
    expect(isValidOsgiVersion("1.2.3")).toBe(true);
    expect(isValidOsgiVersion("1.2.3.qualifier")).toBe(true);
  });
  test("rejects malformed versions", () => {
    expect(isValidOsgiVersion("1.2.3.4.5")).toBe(false);
    expect(isValidOsgiVersion("v1.2.3")).toBe(false);
    expect(isValidOsgiVersion("1.2.3!")).toBe(false);
  });
});

describe("kind helpers", () => {
  test("dirForKind / classifierForKind / p2JarScope", () => {
    expect(dirForKind("bundle")).toBe("plugins");
    expect(dirForKind("feature")).toBe("features");
    expect(classifierForKind("bundle")).toBe("osgi.bundle");
    expect(classifierForKind("feature")).toBe("org.eclipse.update.feature");
    expect(jarFilename("a.b", "1.2.3")).toBe("a.b_1.2.3.jar");
    expect(p2JarScope("bundle", "a.b_1.2.3.jar")).toBe("plugins/a.b_1.2.3.jar");
    expect(p2JarScope("feature", "a.b_1.2.3.jar")).toBe("features/a.b_1.2.3.jar");
  });
});

describe("JarFilenameSchema", () => {
  test("accepts .jar filenames and rejects paths / non-jar", () => {
    expect(JarFilenameSchema.safeParse("a.b_1.2.3.jar").success).toBe(true);
    expect(JarFilenameSchema.safeParse("a/b.jar").success).toBe(false);
    expect(JarFilenameSchema.safeParse("a.txt").success).toBe(false);
  });
});

describe("parseP2VersionMeta", () => {
  test("round-trips valid metadata and rejects garbage", () => {
    const ok = parseP2VersionMeta({
      symbolicName: "a.b",
      version: "1.2.3",
      kind: "bundle",
      filename: "a.b_1.2.3.jar",
      blobDigest: `sha256:${"a".repeat(64)}`,
      sizeBytes: 10,
    });
    expect(ok?.symbolicName).toBe("a.b");
    expect(parseP2VersionMeta({ symbolicName: "a.b" })).toBeNull();
    expect(parseP2VersionMeta(null)).toBeNull();
  });

  test("rejects a filename with path separators", () => {
    expect(
      parseP2VersionMeta({
        symbolicName: "a.b",
        version: "1.2.3",
        kind: "bundle",
        filename: "../escape.jar",
        blobDigest: `sha256:${"a".repeat(64)}`,
        sizeBytes: 10,
      }),
    ).toBeNull();
  });
});
