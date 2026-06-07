import { describe, expect, test } from "bun:test";
import * as scannerSdk from "./index";

describe("@hootifactory/scanner barrel", () => {
  test("re-exports the orchestration, registry, and runtime helpers", () => {
    // Orchestration.
    expect(typeof scannerSdk.resolveScanners).toBe("function");
    expect(typeof scannerSdk.runContentScanners).toBe("function");
    expect(typeof scannerSdk.runDependencyScanners).toBe("function");
    expect(typeof scannerSdk.streamConsumersFor).toBe("function");
    // Registry.
    expect(typeof scannerSdk.ScannerPluginRegistry).toBe("function");
    expect(scannerSdk.scannerPlugins).toBeInstanceOf(scannerSdk.ScannerPluginRegistry);
    // Runtime helpers.
    expect(typeof scannerSdk.assertDigestPinnedImage).toBe("function");
    expect(typeof scannerSdk.dockerAvailable).toBe("function");
    expect(typeof scannerSdk.dockerScannerRunArgs).toBe("function");
    expect(typeof scannerSdk.hostBinAvailable).toBe("function");
    expect(typeof scannerSdk.isDigestPinnedImage).toBe("function");
    expect(typeof scannerSdk.runCliScanner).toBe("function");
    expect(typeof scannerSdk.runScannerCli).toBe("function");
    expect(typeof scannerSdk.scannerCliAvailable).toBe("function");
    expect(typeof scannerSdk.usesDocker).toBe("function");
  });

  test("re-exports the shared primitives a plugin leans on", () => {
    expect(typeof scannerSdk.safeJsonParse).toBe("function");
    expect(typeof scannerSdk.stripTrailingSlashes).toBe("function");
    expect(typeof scannerSdk.normalizeSeverity).toBe("function");
    expect(typeof scannerSdk.maxSeverity).toBe("function");
    expect(scannerSdk.z).toBeDefined();
    expect(scannerSdk.BoundedLruCache).toBeDefined();
    expect(scannerSdk.SEVERITY_ORDER).toBeDefined();
  });
});
