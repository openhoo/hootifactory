import { describe, expect, test } from "bun:test";
import {
  buildDartPackageListing,
  buildDartVersionEntry,
  compareDartVersions,
  dartArchiveFile,
  dartArchiveUrl,
} from "./dart-metadata";
import type { DartVersionMeta } from "./dart-validation";

function meta(version: string): DartVersionMeta {
  return {
    archiveDigest: `sha256:${"a".repeat(64)}`,
    archiveSha256: "c".repeat(64),
    pubspec: { name: "demo", version },
    published: "2026-01-02T00:00:00.000Z",
  };
}

describe("Dart metadata", () => {
  test("builds the canonical archive filename and absolute download url", () => {
    expect(dartArchiveFile("demo", "1.2.3")).toBe("demo-1.2.3.tar.gz");
    expect(dartArchiveUrl("https://reg.test", "dart/private", "demo", "1.2.3")).toBe(
      "https://reg.test/dart/private/api/archives/demo-1.2.3.tar.gz",
    );
  });

  test("a version entry points archive_url at the absolute download route", () => {
    const entry = buildDartVersionEntry({
      packageName: "demo",
      version: "1.2.3",
      metadata: meta("1.2.3"),
      baseUrl: "https://reg.test",
      mountPath: "dart/private",
    });
    expect(entry).toEqual({
      version: "1.2.3",
      retracted: false,
      archive_url: "https://reg.test/dart/private/api/archives/demo-1.2.3.tar.gz",
      archive_sha256: "c".repeat(64),
      pubspec: { name: "demo", version: "1.2.3" },
      published: "2026-01-02T00:00:00.000Z",
    });
  });

  test("compares versions with prerelease ranking below the matching release", () => {
    expect(compareDartVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareDartVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareDartVersions("1.2.3-beta.1", "1.2.3")).toBeLessThan(0);
    expect(compareDartVersions("1.2.3-beta.2", "1.2.3-beta.1")).toBeGreaterThan(0);
    expect(compareDartVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("listing picks the highest STABLE version as latest", () => {
    const build = (version: string) =>
      buildDartVersionEntry({
        packageName: "demo",
        version,
        metadata: meta(version),
        baseUrl: "https://reg.test",
        mountPath: "dart/private",
      });
    const listing = buildDartPackageListing({
      packageName: "demo",
      versions: [build("1.0.0"), build("2.0.0-dev.1"), build("1.5.0")],
    });
    expect(listing?.latest.version).toBe("1.5.0");
    expect(listing?.versions.map((v) => v.version)).toEqual(["1.0.0", "1.5.0", "2.0.0-dev.1"]);
  });

  test("listing returns null when there are no versions", () => {
    expect(buildDartPackageListing({ packageName: "demo", versions: [] })).toBeNull();
  });
});
