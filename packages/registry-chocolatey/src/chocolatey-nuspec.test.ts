import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { extractNuspecMeta } from "./chocolatey-nuspec";
import { makeStoredZip } from "./testing/zip-fixture";

describe("Chocolatey nuspec extraction", () => {
  test("extracts id, version, and chocolatey descriptive fields", () => {
    const nupkg = makeStoredZip(
      "git.nuspec",
      `<?xml version="1.0"?>
      <package>
        <metadata>
          <id>git</id>
          <version>2.43.0</version>
          <title>Git</title>
          <authors>The Git Development Community</authors>
          <description>Git distributed version control system.</description>
          <tags>git vcs admin</tags>
        </metadata>
      </package>`,
    );

    expect(extractNuspecMeta(nupkg)).toEqual({
      id: "git",
      version: "2.43.0",
      title: "Git",
      authors: "The Git Development Community",
      description: "Git distributed version control system.",
      tags: "git vcs admin",
      dependencies: [],
    });
  });

  test("extracts flat dependency ids and ranges", () => {
    const nupkg = makeStoredZip(
      "vscode.nuspec",
      `<package>
        <metadata>
          <id>vscode</id>
          <version>1.85.0</version>
          <dependencies>
            <dependency id="chocolatey" version="[0.10.3,)" />
            <dependency id="vcredist2015" version="14.0.0" />
          </dependencies>
        </metadata>
      </package>`,
    );

    expect(extractNuspecMeta(nupkg)?.dependencies).toEqual([
      { id: "chocolatey", range: "[0.10.3,)" },
      { id: "vcredist2015", range: "14.0.0" },
    ]);
  });

  test("flattens dependencies declared inside framework groups", () => {
    const nupkg = makeStoredZip(
      "tool.nuspec",
      `<package>
        <metadata>
          <id>tool</id>
          <version>1.0.0</version>
          <dependencies>
            <group targetFramework="net8.0">
              <dependency id="Grouped.Dep" version="2.1.0" />
            </group>
          </dependencies>
        </metadata>
      </package>`,
    );

    expect(extractNuspecMeta(nupkg)?.dependencies).toEqual([{ id: "Grouped.Dep", range: "2.1.0" }]);
  });

  test("inflates a deflated nuspec entry with bounded output", () => {
    const xml = "<package><metadata><id>git</id><version>2.43.0</version></metadata></package>";
    const encoded = new TextEncoder().encode(xml);
    const nupkg = makeStoredZip("git.nuspec", deflateRawSync(encoded), {
      method: 8,
      declaredUncompressedSize: encoded.byteLength,
    });

    expect(extractNuspecMeta(nupkg)).toEqual({
      id: "git",
      version: "2.43.0",
      title: undefined,
      authors: undefined,
      description: undefined,
      tags: undefined,
      dependencies: [],
    });
  });

  test("ignores nested nuspec files and malformed archives", () => {
    expect(
      extractNuspecMeta(makeStoredZip("tools/git.nuspec", "<id>git</id><version>1.0.0</version>")),
    ).toBeNull();
    expect(extractNuspecMeta(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
