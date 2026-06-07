import { describe, expect, test } from "bun:test";
import { parseManifestHeaders, parseOsgiManifest } from "./p2-osgi-manifest";
import { zipSingleEntry } from "./p2-xml";

/** Wrap a MANIFEST.MF body into a single-entry STORED jar (round-trips our reader). */
function jarWithManifest(manifest: string): Uint8Array {
  return zipSingleEntry("META-INF/MANIFEST.MF", new TextEncoder().encode(manifest));
}

const MANIFEST = [
  "Manifest-Version: 1.0",
  "Bundle-ManifestVersion: 2",
  "Bundle-SymbolicName: org.example.bundle;singleton:=true",
  "Bundle-Version: 1.2.3.qualifier",
  "Bundle-Name: Example Bundle",
  "",
].join("\r\n");

describe("parseManifestHeaders", () => {
  test("parses name: value headers, lower-casing names", () => {
    const headers = parseManifestHeaders(MANIFEST);
    expect(headers.get("bundle-symbolicname")).toBe("org.example.bundle;singleton:=true");
    expect(headers.get("bundle-version")).toBe("1.2.3.qualifier");
    expect(headers.get("manifest-version")).toBe("1.0");
  });

  test("unfolds RFC822 continuation lines (leading space)", () => {
    const folded = ["Bundle-SymbolicName: org.example", " .bundle.long", ""].join("\r\n");
    expect(parseManifestHeaders(folded).get("bundle-symbolicname")).toBe("org.example.bundle.long");
  });

  test("tolerates bare LF line endings", () => {
    const headers = parseManifestHeaders("Bundle-SymbolicName: a.b\nBundle-Version: 1.0.0\n");
    expect(headers.get("bundle-symbolicname")).toBe("a.b");
    expect(headers.get("bundle-version")).toBe("1.0.0");
  });
});

describe("parseOsgiManifest", () => {
  test("extracts symbolic name (directives stripped) + version from a jar", () => {
    expect(parseOsgiManifest(jarWithManifest(MANIFEST))).toEqual({
      symbolicName: "org.example.bundle",
      version: "1.2.3.qualifier",
    });
  });

  test("defaults Bundle-Version to 0.0.0 when absent", () => {
    const manifest = ["Bundle-SymbolicName: org.example.nover", ""].join("\r\n");
    expect(parseOsgiManifest(jarWithManifest(manifest))).toEqual({
      symbolicName: "org.example.nover",
      version: "0.0.0",
    });
  });

  test("returns null when Bundle-SymbolicName is missing", () => {
    const manifest = ["Bundle-Version: 1.0.0", ""].join("\r\n");
    expect(parseOsgiManifest(jarWithManifest(manifest))).toBeNull();
  });

  test("returns null for a non-jar / manifest-less archive", () => {
    expect(
      parseOsgiManifest(zipSingleEntry("readme.txt", new TextEncoder().encode("hi"))),
    ).toBeNull();
  });

  test("returns null for a non-zip byte blob", () => {
    expect(parseOsgiManifest(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
  });

  test("rejects a malformed OSGi version", () => {
    const manifest = ["Bundle-SymbolicName: a.b", "Bundle-Version: not.a.version!", ""].join(
      "\r\n",
    );
    expect(parseOsgiManifest(jarWithManifest(manifest))).toBeNull();
  });

  test("rejects an invalid symbolic name", () => {
    const manifest = ["Bundle-SymbolicName: bad name", "Bundle-Version: 1.0.0", ""].join("\r\n");
    expect(parseOsgiManifest(jarWithManifest(manifest))).toBeNull();
  });
});
