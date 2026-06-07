import { describe, expect, test } from "bun:test";
import { buildOpamFile, opamDepend, opamString, serializeOpamFile } from "./opam-file";
import type { OpamVersionMeta } from "./opam-validation";

const HEX = "a".repeat(64);

describe("opam file serializer", () => {
  test("quotes and escapes opam string literals", () => {
    expect(opamString("plain")).toBe('"plain"');
    expect(opamString('he said "hi"')).toBe('"he said \\"hi\\""');
    expect(opamString("a\\b")).toBe('"a\\\\b"');
    // Control characters are escaped so a multi-line value cannot break the
    // line-based opam serialization.
    expect(opamString("line1\nline2")).toBe('"line1\\nline2"');
    expect(opamString("a\tb\rc")).toBe('"a\\tb\\rc"');
  });

  test("renders a bare dependency and one with a version constraint", () => {
    expect(opamDepend({ name: "dune" })).toBe('"dune"');
    expect(opamDepend({ name: "ocaml", constraint: '>= "4.08"' })).toBe('"ocaml" { >= "4.08" }');
  });

  test("serializes a full opam file with a url section", () => {
    const text = serializeOpamFile({
      name: "lwt",
      version: "5.6.1",
      maintainer: "team@example.test",
      homepage: "https://example.test",
      license: "MIT",
      synopsis: "Promises and concurrency",
      depends: [{ name: "ocaml", constraint: '>= "4.08"' }, { name: "dune" }],
      url: { src: "https://reg.test/opam/o/r/archives/lwt/5.6.1/lwt-5.6.1.tar.gz", sha256: HEX },
    });
    expect(text).toBe(
      [
        'opam-version: "2.0"',
        'name: "lwt"',
        'version: "5.6.1"',
        'maintainer: "team@example.test"',
        'homepage: "https://example.test"',
        'license: "MIT"',
        'synopsis: "Promises and concurrency"',
        'depends: [ "ocaml" { >= "4.08" } "dune" ]',
        "url {",
        '  src: "https://reg.test/opam/o/r/archives/lwt/5.6.1/lwt-5.6.1.tar.gz"',
        `  checksum: [ "sha256=${HEX}" ]`,
        "}",
        "",
      ].join("\n"),
    );
  });

  test("omits optional fields and the depends list when empty", () => {
    const text = serializeOpamFile({ name: "x", version: "1.0", depends: [] });
    expect(text).toBe(['opam-version: "2.0"', 'name: "x"', 'version: "1.0"', ""].join("\n"));
  });

  test("buildOpamFile points url.src at the provided archive URL with the stored sha256", () => {
    const meta: OpamVersionMeta = {
      name: "lwt",
      version: "5.6.1",
      synopsis: "Promises",
      blobDigest: `sha256:${HEX}`,
      sha256: HEX,
      filename: "lwt-5.6.1.tar.gz",
    };
    const text = buildOpamFile(
      meta,
      "https://reg.test/opam/o/r/archives/lwt/5.6.1/lwt-5.6.1.tar.gz",
    );
    expect(text).toContain('name: "lwt"');
    expect(text).toContain('version: "5.6.1"');
    expect(text).toContain('synopsis: "Promises"');
    expect(text).toContain('src: "https://reg.test/opam/o/r/archives/lwt/5.6.1/lwt-5.6.1.tar.gz"');
    expect(text).toContain(`checksum: [ "sha256=${HEX}" ]`);
  });
});
