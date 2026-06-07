import { describe, expect, test } from "bun:test";
import { parseControlFields } from "./control-stanza";
import { buildPackageStanza, buildPackagesIndex, type CranIndexEntry } from "./cran-index";

function entry(name: string, version: string, fields: Array<[string, string]>): CranIndexEntry {
  return { name, version, controlFields: fields, md5: "d".repeat(32) };
}

describe("CRAN PACKAGES index", () => {
  test("a stanza leads with Package/Version and ends with MD5sum", () => {
    const stanza = buildPackageStanza(
      entry("demo", "1.2.3", [
        ["Title", "A Demo"],
        ["Depends", "R (>= 3.5.0)"],
      ]),
    );
    expect(stanza).toBe(
      "Package: demo\nVersion: 1.2.3\nTitle: A Demo\nDepends: R (>= 3.5.0)\nMD5sum: " +
        "d".repeat(32),
    );
    // It is re-parseable as a control stanza.
    const parsed = parseControlFields(stanza);
    expect(parsed.Package).toBe("demo");
    expect(parsed.Version).toBe("1.2.3");
    expect(parsed.MD5sum).toBe("d".repeat(32));
  });

  test("drops a duplicate Package/Version/MD5sum carried in DESCRIPTION fields", () => {
    const stanza = buildPackageStanza(
      entry("demo", "1.2.3", [
        ["Package", "evil"],
        ["MD5sum", "0".repeat(32)],
        ["Title", "Demo"],
      ]),
    );
    expect(stanza).toBe(`Package: demo\nVersion: 1.2.3\nTitle: Demo\nMD5sum: ${"d".repeat(32)}`);
  });

  test("concatenates stanzas in deterministic (Package, Version) order", () => {
    const index = buildPackagesIndex([
      entry("zeta", "1.0", [["Title", "Z"]]),
      entry("alpha", "2.0", [["Title", "A2"]]),
      entry("alpha", "1.0", [["Title", "A1"]]),
    ]);
    const stanzas = index.trimEnd().split("\n\n");
    expect(stanzas.map((s) => parseControlFields(s).Package)).toEqual(["alpha", "alpha", "zeta"]);
    expect(stanzas.map((s) => parseControlFields(s).Version)).toEqual(["1.0", "2.0", "1.0"]);
    expect(index.endsWith("\n")).toBe(true);
  });

  test("an empty repo yields an empty index", () => {
    expect(buildPackagesIndex([])).toBe("");
  });
});
