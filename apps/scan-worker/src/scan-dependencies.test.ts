import { describe, expect, test } from "bun:test";
import { dependenciesFromMetadata } from "./scan-dependencies";

describe("scan dependency extraction", () => {
  test("collects npm production and development dependencies", () => {
    expect(
      dependenciesFromMetadata("npm", {
        manifest: {
          dependencies: { react: "^19.0.0", ignored: 19 },
          devDependencies: { typescript: "^5.0.0" },
        },
      }),
    ).toEqual({
      deps: { react: "^19.0.0", typescript: "^5.0.0" },
      osvEcosystem: "npm",
    });
  });

  test("collects Cargo and NuGet dependency metadata defensively", () => {
    expect(
      dependenciesFromMetadata("cargo", {
        index: { deps: [{ name: "serde", req: "^1" }, { name: "ignored" }, null] },
      }),
    ).toEqual({
      deps: { serde: "^1" },
      osvEcosystem: "crates.io",
    });

    expect(
      dependenciesFromMetadata("nuget", {
        dependencyGroups: [
          { dependencies: [{ id: "Newtonsoft.Json", range: "[13.0.1, )" }, { id: "ignored" }] },
        ],
      }),
    ).toEqual({
      deps: { "Newtonsoft.Json": "[13.0.1, )" },
      osvEcosystem: "NuGet",
    });
  });

  test("collects single-line Go require directives", () => {
    expect(
      dependenciesFromMetadata("go", {
        mod: [
          "module example.test/app",
          "require github.com/gin-gonic/gin v1.10.0",
          "require (",
          "  github.com/ignored/module v1.0.0",
          ")",
        ].join("\n"),
      }),
    ).toEqual({
      deps: { "github.com/gin-gonic/gin": "v1.10.0" },
      osvEcosystem: "Go",
    });
  });
});
