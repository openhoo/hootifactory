import { describe, expect, test } from "bun:test";
import {
  contentTypeForPath,
  isIvyDescriptor,
  isSafeIvyPath,
  isScannableIvyArtifact,
  ivyDescriptorFile,
  ivyPackageForPath,
  ivyPackageName,
  parseChecksumPath,
  parseIvyCoordinates,
} from "./ivy-validation";

describe("isSafeIvyPath", () => {
  test("accepts well-formed Ivy file paths", () => {
    expect(isSafeIvyPath("org.example/demo/1.2.3/ivy-1.2.3.xml")).toBe(true);
    expect(isSafeIvyPath("org.example/demo/1.2.3/demo-1.2.3.jar")).toBe(true);
  });

  test("rejects traversal, absolute, empty, and trailing-slash paths", () => {
    expect(isSafeIvyPath("")).toBe(false);
    expect(isSafeIvyPath("/org/demo")).toBe(false);
    expect(isSafeIvyPath("org/demo/")).toBe(false);
    expect(isSafeIvyPath("org/../etc/passwd")).toBe(false);
    expect(isSafeIvyPath("org/./demo")).toBe(false);
    expect(isSafeIvyPath("org/de mo/1.0/x.jar")).toBe(false);
  });
});

describe("parseIvyCoordinates", () => {
  test("parses the four-segment Ivy layout", () => {
    expect(parseIvyCoordinates("org.example/demo/1.2.3/demo-1.2.3.jar")).toEqual({
      organisation: "org.example",
      module: "demo",
      revision: "1.2.3",
      file: "demo-1.2.3.jar",
    });
  });

  test("returns null for paths that are not exactly four segments", () => {
    expect(parseIvyCoordinates("org.example/demo/1.2.3")).toBeNull();
    expect(parseIvyCoordinates("org.example/demo/1.2.3/x/y.jar")).toBeNull();
    expect(parseIvyCoordinates("org.example/demo/maven-metadata.xml")).toBeNull();
  });
});

describe("isIvyDescriptor", () => {
  test("recognizes ivy-<revision>.xml as the descriptor", () => {
    const coords = parseIvyCoordinates("org.example/demo/1.2.3/ivy-1.2.3.xml");
    expect(coords && isIvyDescriptor(coords)).toBe(true);
  });

  test("an artifact file is not the descriptor", () => {
    const coords = parseIvyCoordinates("org.example/demo/1.2.3/demo-1.2.3.jar");
    expect(coords && isIvyDescriptor(coords)).toBe(false);
  });

  test("ivyDescriptorFile builds the canonical descriptor name", () => {
    expect(ivyDescriptorFile("9.9.9")).toBe("ivy-9.9.9.xml");
  });
});

describe("parseChecksumPath", () => {
  test("splits a .sha1/.md5 sidecar into base + algorithm", () => {
    expect(parseChecksumPath("a/b/1.0/c-1.0.jar.sha1")).toEqual({
      base: "a/b/1.0/c-1.0.jar",
      algorithm: "sha1",
    });
    expect(parseChecksumPath("a/b/1.0/ivy-1.0.xml.md5")).toEqual({
      base: "a/b/1.0/ivy-1.0.xml",
      algorithm: "md5",
    });
  });

  test("returns null for non-checksum paths", () => {
    expect(parseChecksumPath("a/b/1.0/c-1.0.jar")).toBeNull();
    expect(parseChecksumPath("a/b/1.0/ivy-1.0.xml")).toBeNull();
    // A bare ".sha1" with no base is not a valid sidecar.
    expect(parseChecksumPath(".sha1")).toBeNull();
  });
});

describe("isScannableIvyArtifact", () => {
  test("jars and other JVM archives are scannable", () => {
    expect(isScannableIvyArtifact("o/m/1.0/m-1.0.jar")).toBe(true);
    expect(isScannableIvyArtifact("o/m/1.0/m-1.0.war")).toBe(true);
  });

  test("descriptor, checksum sidecars, and sources are not scanned", () => {
    expect(isScannableIvyArtifact("o/m/1.0/ivy-1.0.xml")).toBe(false);
    expect(isScannableIvyArtifact("o/m/1.0/m-1.0.jar.sha1")).toBe(false);
    expect(isScannableIvyArtifact("o/m/1.0/m-1.0.pom")).toBe(false);
  });
});

describe("ivy package naming", () => {
  test("ivyPackageName joins organisation#module", () => {
    expect(ivyPackageName("org.example", "demo")).toBe("org.example#demo");
  });

  test("ivyPackageForPath returns the package for a real Ivy file path", () => {
    expect(ivyPackageForPath("org.example/demo/1.2.3/demo-1.2.3.jar")).toBe("org.example#demo");
    expect(ivyPackageForPath("org.example/demo/maven-metadata.xml")).toBeNull();
  });
});

describe("contentTypeForPath", () => {
  test("maps known extensions, defaulting to octet-stream", () => {
    expect(contentTypeForPath("o/m/1.0/ivy-1.0.xml")).toBe("application/xml");
    expect(contentTypeForPath("o/m/1.0/m-1.0.jar")).toBe("application/java-archive");
    expect(contentTypeForPath("o/m/1.0/m-1.0.jar.sha1")).toBe("text/plain");
    expect(contentTypeForPath("o/m/1.0/m-1.0.bin")).toBe("application/octet-stream");
  });
});
