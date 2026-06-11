import { describe, expect, test } from "bun:test";
import {
  createScannerRuntime,
  loadConfiguredScanners,
  SCANNER_MANIFEST,
  scannerRuntimeOptionsFromEnv,
} from "./index";

describe("@hootifactory/scanner-runtime barrel", () => {
  test("re-exports the loader helpers and the static manifest", () => {
    expect(typeof loadConfiguredScanners).toBe("function");
    expect(typeof createScannerRuntime).toBe("function");
    expect(typeof scannerRuntimeOptionsFromEnv).toBe("function");
    expect(Array.isArray(SCANNER_MANIFEST)).toBe(true);
    // The manifest names every built-in scanner exactly once.
    const ids = SCANNER_MANIFEST.map((plugin) => plugin.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("heuristic-malware");
    expect(ids).toContain("heuristic-deps");
  });

  test("scannerRuntimeOptionsFromEnv builds cross-scanner runtime knobs", () => {
    const options = scannerRuntimeOptionsFromEnv();
    // Shape is config-driven; assert the generic knobs are present (no per-scanner identity).
    expect(options).toHaveProperty("cliRuntime");
    expect(options).toHaveProperty("timeoutMs");
    expect(options).toHaveProperty("maxOutputBytes");
    expect(options).not.toHaveProperty("image");
  });
});
