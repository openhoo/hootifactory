import { describe, expect, test } from "bun:test";
import {
  buildHexVersionMeta,
  HexReleaseMetadataSchema,
  HexTarballFilenameSchema,
  HexVersionMetaSchema,
  hexTarballFile,
  isValidHexPackageName,
  isValidHexVersion,
  parseHexVersionMeta,
  splitTarballFile,
} from "./hex-validation";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OUTER = "a".repeat(64);
const INNER = "b".repeat(64);

describe("Hex validation", () => {
  test("accepts lowercase package names and rejects path-y/uppercase ones", () => {
    expect(isValidHexPackageName("phoenix")).toBe(true);
    expect(isValidHexPackageName("ecto_sql")).toBe(true);
    expect(isValidHexPackageName("a1_b2")).toBe(true);
    expect(isValidHexPackageName("1leading")).toBe(false);
    expect(isValidHexPackageName("Phoenix")).toBe(false);
    expect(isValidHexPackageName("bad-name")).toBe(false);
    expect(isValidHexPackageName("bad/name")).toBe(false);
    expect(isValidHexPackageName("")).toBe(false);
  });

  test("accepts SemVer versions and rejects malformed ones", () => {
    expect(isValidHexVersion("1.2.3")).toBe(true);
    expect(isValidHexVersion("1.0.0-rc.1")).toBe(true);
    expect(isValidHexVersion("1.0.0+build.5")).toBe(true);
    expect(isValidHexVersion("1.2")).toBe(false);
    expect(isValidHexVersion("v1.2.3")).toBe(false);
    expect(isValidHexVersion("1.2.3 ")).toBe(false);
  });

  test("tarball filename schema rejects traversal and bad shapes", () => {
    expect(HexTarballFilenameSchema.safeParse("demo-1.2.3.tar").success).toBe(true);
    expect(HexTarballFilenameSchema.safeParse("ecto_sql-3.10.0.tar").success).toBe(true);
    expect(HexTarballFilenameSchema.safeParse("sub/demo-1.0.0.tar").success).toBe(false);
    expect(HexTarballFilenameSchema.safeParse("demo-1.0.0.tar.gz").success).toBe(false);
    expect(HexTarballFilenameSchema.safeParse("Demo-1.0.0.tar").success).toBe(false);
  });

  test("splitTarballFile recovers name + version, or null", () => {
    expect(splitTarballFile("demo-1.2.3.tar")).toEqual({ name: "demo", version: "1.2.3" });
    expect(splitTarballFile("ecto_sql-3.10.0-rc.1.tar")).toEqual({
      name: "ecto_sql",
      version: "3.10.0-rc.1",
    });
    expect(splitTarballFile("demo-1.2.3.zip")).toBeNull();
    expect(splitTarballFile("nodash.tar")).toBeNull();
    expect(splitTarballFile("demo-not-semver.tar")).toBeNull();
  });

  test("hexTarballFile composes the canonical download name", () => {
    expect(hexTarballFile("demo", "1.2.3")).toBe("demo-1.2.3.tar");
  });

  test("release metadata schema requires name/version/app", () => {
    expect(
      HexReleaseMetadataSchema.safeParse({ name: "demo", version: "1.0.0", app: "demo" }).success,
    ).toBe(true);
    expect(HexReleaseMetadataSchema.safeParse({ name: "demo", version: "1.0.0" }).success).toBe(
      false,
    );
    expect(
      HexReleaseMetadataSchema.safeParse({ name: "demo", version: "bad", app: "demo" }).success,
    ).toBe(false);
  });

  test("buildHexVersionMeta + parseHexVersionMeta round-trip", () => {
    const meta = buildHexVersionMeta(
      HexReleaseMetadataSchema.parse({
        name: "demo",
        version: "1.2.3",
        app: "demo",
        description: "demo pkg",
        licenses: ["MIT"],
        requirements: { poison: { requirement: "~> 1.0" } },
      }),
      { digest: DIGEST, outerChecksum: OUTER, innerChecksum: INNER },
    );
    expect(meta.blobDigest).toBe(DIGEST);
    expect(meta.outerChecksum).toBe(OUTER);
    expect(meta.innerChecksum).toBe(INNER);
    expect(meta.metadata.requirements).toEqual({ poison: { requirement: "~> 1.0" } });
    expect(HexVersionMetaSchema.safeParse(meta).success).toBe(true);
    expect(parseHexVersionMeta(meta)).not.toBeNull();
  });

  test("parseHexVersionMeta rejects malformed metadata", () => {
    expect(parseHexVersionMeta(null)).toBeNull();
    expect(parseHexVersionMeta({ metadata: { name: "demo" } })).toBeNull();
    expect(
      parseHexVersionMeta({
        metadata: { name: "demo", version: "1.0.0", app: "demo" },
        blobDigest: "nope",
        outerChecksum: OUTER,
        innerChecksum: INNER,
        published: "now",
      }),
    ).toBeNull();
  });
});
