import { describe, expect, test } from "bun:test";
import {
  buildPubPackageListing,
  buildPubVersionEntry,
  comparePubVersions,
  isPrereleasePubVersion,
  pubArchiveFile,
  pubArchiveUrl,
} from "./pub-metadata";
import type { PubVersionMeta } from "./pub-validation";

function meta(version: string): PubVersionMeta {
  return {
    archiveDigest: `sha256:${"a".repeat(64)}`,
    archiveSha256: "c".repeat(64),
    pubspec: { name: "demo", version },
    published: "2026-01-02T00:00:00.000Z",
  };
}

describe("Pub metadata", () => {
  test("builds the canonical archive filename and absolute download url", () => {
    expect(pubArchiveFile("demo", "1.2.3")).toBe("demo-1.2.3.tar.gz");
    expect(pubArchiveUrl("https://reg.test", "pub/private", "demo", "1.2.3")).toBe(
      "https://reg.test/pub/private/api/archives/demo-1.2.3.tar.gz",
    );
  });

  test("a version entry points archive_url at the absolute download route", () => {
    const entry = buildPubVersionEntry({
      packageName: "demo",
      version: "1.2.3",
      metadata: meta("1.2.3"),
      baseUrl: "https://reg.test",
      mountPath: "pub/private",
    });
    expect(entry).toEqual({
      version: "1.2.3",
      retracted: false,
      archive_url: "https://reg.test/pub/private/api/archives/demo-1.2.3.tar.gz",
      archive_sha256: "c".repeat(64),
      pubspec: { name: "demo", version: "1.2.3" },
      published: "2026-01-02T00:00:00.000Z",
    });
  });

  test("compares versions with prerelease ranking below the matching release", () => {
    expect(comparePubVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(comparePubVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(comparePubVersions("1.2.3-beta.1", "1.2.3")).toBeLessThan(0);
    expect(comparePubVersions("1.2.3-beta.2", "1.2.3-beta.1")).toBeGreaterThan(0);
    expect(comparePubVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("listing picks the highest STABLE version as latest", () => {
    const build = (version: string) =>
      buildPubVersionEntry({
        packageName: "demo",
        version,
        metadata: meta(version),
        baseUrl: "https://reg.test",
        mountPath: "pub/private",
      });
    const listing = buildPubPackageListing({
      packageName: "demo",
      versions: [build("1.0.0"), build("2.0.0-dev.1"), build("1.5.0")],
    });
    expect(listing?.latest.version).toBe("1.5.0");
    expect(listing?.versions.map((v) => v.version)).toEqual(["1.0.0", "1.5.0", "2.0.0-dev.1"]);
  });

  test("treats build metadata with a hyphen as stable, not a prerelease", () => {
    expect(isPrereleasePubVersion("1.0.0+2026-06-06")).toBe(false);
    expect(isPrereleasePubVersion("1.5.0+build-7")).toBe(false);
    expect(isPrereleasePubVersion("1.0.0-beta")).toBe(true);
    expect(isPrereleasePubVersion("1.0.0-beta+build-7")).toBe(true);
  });

  test("listing picks the higher stable build-metadata version as latest", () => {
    const build = (version: string) =>
      buildPubVersionEntry({
        packageName: "demo",
        version,
        metadata: meta(version),
        baseUrl: "https://reg.test",
        mountPath: "pub/private",
      });
    const listing = buildPubPackageListing({
      packageName: "demo",
      versions: [build("1.0.0"), build("1.5.0+build-7")],
    });
    expect(listing?.latest.version).toBe("1.5.0+build-7");
  });

  test("listing returns null when there are no versions", () => {
    expect(buildPubPackageListing({ packageName: "demo", versions: [] })).toBeNull();
  });
});
