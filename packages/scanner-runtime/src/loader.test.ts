import { describe, expect, test } from "bun:test";
import { ScannerPluginRegistry } from "@hootifactory/scanner";
import { createScannerRuntime, loadConfiguredScanners } from "./loader";
import { SCANNER_MANIFEST } from "./manifest";

describe("loadConfiguredScanners", () => {
  test("registers the whole manifest when no allowlist is given", () => {
    const registry = new ScannerPluginRegistry();
    const { registered, unknown } = loadConfiguredScanners(registry, { enabled: undefined });
    expect(registered.sort()).toEqual(SCANNER_MANIFEST.map((plugin) => plugin.id).sort());
    expect(unknown).toEqual([]);
  });

  test("registers the allowlisted scanners (plus the always-on baseline) and reports unknown ids", () => {
    const registry = new ScannerPluginRegistry();
    const { registered, unknown } = loadConfiguredScanners(registry, {
      enabled: ["grype", "bogus"],
    });
    // grype was allowlisted; the heuristic baseline is always registered.
    expect(registered.sort()).toEqual(["grype", "heuristic-deps", "heuristic-malware"]);
    expect(registry.has("osv")).toBe(false);
    expect(registry.has("trivy")).toBe(false);
    expect(unknown).toEqual(["bogus"]);
  });

  test("never lets the allowlist disable the offline baseline scanners", () => {
    const registry = new ScannerPluginRegistry();
    // An allowlist that omits the heuristic baseline entirely still registers it.
    loadConfiguredScanners(registry, { enabled: ["grype"] });
    expect(registry.has("heuristic-malware")).toBe(true);
    expect(registry.has("heuristic-deps")).toBe(true);
  });

  test("createScannerRuntime resolves config + availability for every registered scanner", () => {
    const registry = new ScannerPluginRegistry();
    loadConfiguredScanners(registry, { enabled: ["heuristic-malware", "heuristic-deps"] });
    const runtime = createScannerRuntime(registry);
    expect(runtime.scanners.map((s) => s.plugin.id).sort()).toEqual([
      "heuristic-deps",
      "heuristic-malware",
    ]);
    expect(runtime.scanners.every((s) => s.available)).toBe(true);
  });
});
