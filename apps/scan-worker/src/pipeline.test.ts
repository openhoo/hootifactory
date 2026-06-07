import { describe, expect, test } from "bun:test";
import { mapWithBoundedConcurrency } from "@hootifactory/core";
import type { ResolvedScanner, ScannerRuntime, ScannerRuntimeOptions } from "@hootifactory/scanner";
// These are re-exported by `./pipeline`, but importing them from there would
// eagerly evaluate the whole pipeline graph (real `@hootifactory/db` +
// `@hootifactory/storage` handles) before the mock-based sibling tests register
// their `mock.module` stubs — which hangs those tests against an unreachable
// DB/S3 in CI. Import the pure helpers from their storage/db-free leaf sources.
import {
  externalContentScannerRequested,
  shouldFailForMissingExternalScanner,
} from "./scan-runtime";

function contentScanner(
  id: string,
  available: boolean,
  requiresExternalRuntime = false,
): ResolvedScanner {
  return {
    plugin: {
      id,
      displayName: id,
      capabilities: { inputKind: "content", findingTypes: new Set(["vuln"]), network: false },
      configFromEnv: () => null,
      available: () => available,
      requiresExternalRuntime: () => requiresExternalRuntime,
      scanContent: () => Promise.resolve([]),
    },
    config: null,
    available,
  };
}

function runtime(options: ScannerRuntimeOptions, scanners: ResolvedScanner[]): ScannerRuntime {
  return { options, scanners };
}

describe("scan pipeline pure helpers", () => {
  test("fails closed when a configured external scanner runtime has no content scanner", () => {
    expect(externalContentScannerRequested(runtime({ cliRuntime: "disabled" }, []))).toBe(false);
    expect(
      shouldFailForMissingExternalScanner(
        runtime({ cliRuntime: "docker" }, [contentScanner("grype", false)]),
      ),
    ).toBe(true);
    expect(
      shouldFailForMissingExternalScanner(
        runtime({ cliRuntime: "host" }, [contentScanner("grype", false)]),
      ),
    ).toBe(true);
    expect(
      shouldFailForMissingExternalScanner(
        runtime({ cliRuntime: "docker" }, [contentScanner("grype", true)]),
      ),
    ).toBe(false);
    // External runtime requested via an explicit endpoint (e.g. clamav REST) but the
    // CLI runtime is disabled: still fail-closed only when nothing is available.
    expect(
      shouldFailForMissingExternalScanner(
        runtime({ cliRuntime: "disabled" }, [contentScanner("clamav", true, true)]),
      ),
    ).toBe(false);
  });

  test("maps work with bounded concurrency and preserves result order", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapWithBoundedConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return value * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  test("rejects invalid concurrency limits", async () => {
    await expect(mapWithBoundedConcurrency([1], 0, async (value) => value)).rejects.toThrow(
      "concurrency must be a positive integer",
    );
  });
});
