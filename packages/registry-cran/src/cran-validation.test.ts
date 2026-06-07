import { describe, expect, test } from "bun:test";
import {
  CranVersionMetaSchema,
  cranTarballFilename,
  isValidCranPackageName,
  isValidCranVersion,
  parseCranTarballFilename,
  parseCranVersionMeta,
} from "./cran-validation";

describe("CRAN name + version validation", () => {
  test("accepts well-formed package names", () => {
    for (const name of ["ggplot2", "data.table", "Rcpp", "A3", "knitr"]) {
      expect(isValidCranPackageName(name)).toBe(true);
    }
  });

  test("rejects malformed package names", () => {
    for (const name of ["1abc", "a", ".hidden", "ends.", "has space", "has_underscore"]) {
      expect(isValidCranPackageName(name)).toBe(false);
    }
  });

  test("accepts well-formed versions", () => {
    for (const version of ["1.0", "1.2.3", "0.9-7", "2024.1.0"]) {
      expect(isValidCranVersion(version)).toBe(true);
    }
  });

  test("rejects malformed versions", () => {
    for (const version of ["1.0a", "v1.0", ".1", "1.", "1..2", ""]) {
      expect(isValidCranVersion(version)).toBe(false);
    }
  });
});

describe("CRAN tarball filename parsing", () => {
  test("splits <pkg>_<version>.tar.gz", () => {
    expect(parseCranTarballFilename("data.table_1.15.0.tar.gz")).toEqual({
      name: "data.table",
      version: "1.15.0",
    });
    expect(parseCranTarballFilename("Rcpp_1.0.12.tar.gz")).toEqual({
      name: "Rcpp",
      version: "1.0.12",
    });
  });

  test("rejects traversal, wrong suffix, or missing separator", () => {
    expect(parseCranTarballFilename("../etc_1.0.tar.gz")).toBeNull();
    expect(parseCranTarballFilename("a/b_1.0.tar.gz")).toBeNull();
    expect(parseCranTarballFilename("demo-1.0.tar.gz")).toBeNull();
    expect(parseCranTarballFilename("demo_1.0.zip")).toBeNull();
    expect(parseCranTarballFilename("_1.0.tar.gz")).toBeNull();
  });

  test("round-trips with cranTarballFilename", () => {
    expect(cranTarballFilename("demo", "1.2.3")).toBe("demo_1.2.3.tar.gz");
    expect(parseCranTarballFilename(cranTarballFilename("demo", "1.2.3"))).toEqual({
      name: "demo",
      version: "1.2.3",
    });
  });
});

describe("CRAN version metadata schema", () => {
  const meta = {
    name: "demo",
    version: "1.2.3",
    controlFields: [["Title", "Demo"]] as Array<[string, string]>,
    deps: ["R", "Rcpp"],
    blobDigest: `sha256:${"a".repeat(64)}`,
    sha256: "a".repeat(64),
    md5: "b".repeat(32),
    sizeBytes: 100,
  };

  test("accepts a complete metadata record", () => {
    expect(CranVersionMetaSchema.safeParse(meta).success).toBe(true);
    expect(parseCranVersionMeta(meta)).not.toBeNull();
  });

  test("rejects a bad digest or md5", () => {
    expect(parseCranVersionMeta({ ...meta, blobDigest: "nope" })).toBeNull();
    expect(parseCranVersionMeta({ ...meta, md5: "short" })).toBeNull();
    expect(parseCranVersionMeta(null)).toBeNull();
  });
});
