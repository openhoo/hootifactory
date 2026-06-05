import { describe, expect, test } from "bun:test";
import {
  isValidDartPackageName,
  isValidDartVersion,
  parseDartVersionMeta,
  parsePubspecYaml,
} from "./dart-validation";

describe("Dart validation", () => {
  test("accepts lowercase identifier package names and rejects others", () => {
    expect(isValidDartPackageName("provider")).toBe(true);
    expect(isValidDartPackageName("flutter_bloc")).toBe(true);
    expect(isValidDartPackageName("path2")).toBe(true);
    expect(isValidDartPackageName("Provider")).toBe(false);
    expect(isValidDartPackageName("bad-name")).toBe(false);
    expect(isValidDartPackageName("bad/name")).toBe(false);
    expect(isValidDartPackageName("../etc")).toBe(false);
    expect(isValidDartPackageName("")).toBe(false);
  });

  test("validates SemVer versions including prerelease and build metadata", () => {
    expect(isValidDartVersion("1.2.3")).toBe(true);
    expect(isValidDartVersion("0.0.1")).toBe(true);
    expect(isValidDartVersion("1.2.3-beta.1")).toBe(true);
    expect(isValidDartVersion("1.2.3-beta.1+build.7")).toBe(true);
    expect(isValidDartVersion("1.2")).toBe(false);
    expect(isValidDartVersion("01.2.3")).toBe(false);
    expect(isValidDartVersion("v1.2.3")).toBe(false);
  });

  test("parses top-level pubspec scalars and one level of dependency maps", () => {
    const pubspec = parsePubspecYaml(
      [
        "name: demo",
        "version: 1.2.3",
        "description: A demo package # inline comment",
        "environment:",
        "  sdk: '>=3.0.0 <4.0.0'",
        "dependencies:",
        "  provider: ^6.0.0",
        "  http: ^1.0.0",
        "# a comment line",
        "dev_dependencies:",
        "  lints: ^3.0.0",
      ].join("\n"),
    );
    expect(pubspec.name).toBe("demo");
    expect(pubspec.version).toBe("1.2.3");
    expect(pubspec.description).toBe("A demo package");
    expect(pubspec.environment).toEqual({ sdk: ">=3.0.0 <4.0.0" });
    expect(pubspec.dependencies).toEqual({ provider: "^6.0.0", http: "^1.0.0" });
    expect(pubspec.dev_dependencies).toEqual({ lints: "^3.0.0" });
  });

  test("round-trips a stored version metadata object through the schema", () => {
    const meta = {
      archiveDigest: `sha256:${"a".repeat(64)}`,
      archiveSha256: "b".repeat(64),
      pubspec: { name: "demo", version: "1.2.3" },
      published: "2026-01-02T00:00:00.000Z",
    };
    expect(parseDartVersionMeta(meta)).toEqual(meta);
    expect(parseDartVersionMeta({ archiveDigest: "nope" })).toBeNull();
    expect(parseDartVersionMeta(null)).toBeNull();
  });
});
