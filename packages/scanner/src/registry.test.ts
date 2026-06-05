import { describe, expect, test } from "bun:test";
import { ScannerPluginRegistry } from "./registry";
import type { ScannerPlugin } from "./types";

function depScanner(id: string): ScannerPlugin<null> {
  return {
    id,
    displayName: id,
    capabilities: { inputKind: "dependencies", findingTypes: new Set(["vuln"]), network: false },
    configFromEnv: () => null,
    available: () => true,
    scanDependencies: () => Promise.resolve([]),
  };
}

describe("ScannerPluginRegistry", () => {
  test("registers and looks up plugins, and indexes them by input kind", () => {
    const registry = new ScannerPluginRegistry();
    registry.register(depScanner("a"));
    registry.register(depScanner("b"));
    expect(registry.has("a")).toBe(true);
    expect(registry.all().map((p) => p.id)).toEqual(["a", "b"]);
    expect(registry.forInputKind("dependencies").map((p) => p.id)).toEqual(["a", "b"]);
    expect(registry.forInputKind("content")).toEqual([]);
  });

  test("rejects duplicate ids", () => {
    const registry = new ScannerPluginRegistry();
    registry.register(depScanner("a"));
    expect(() => registry.register(depScanner("a"))).toThrow(/already registered/);
  });

  test("rejects a plugin whose declared input kind has no matching entry point", () => {
    const registry = new ScannerPluginRegistry();
    const broken: ScannerPlugin<null> = {
      id: "broken",
      displayName: "broken",
      capabilities: { inputKind: "content", findingTypes: new Set(["vuln"]), network: false },
      configFromEnv: () => null,
      available: () => true,
      // no scanContent
    };
    expect(() => registry.register(broken)).toThrow(/does not implement scanContent/);
  });
});
