import { describe, expect, test } from "bun:test";
import {
  externalContentScannerRequired,
  mapWithBoundedConcurrency,
  shouldFailForMissingExternalScanner,
} from "./pipeline";

describe("scan pipeline pure helpers", () => {
  test("fails closed when a configured external scanner runtime has no content scanner", () => {
    expect(externalContentScannerRequired({ cliRuntime: "disabled" })).toBe(false);
    expect(
      shouldFailForMissingExternalScanner(
        { cliRuntime: "docker" },
        { syft: false, grype: false, trivy: false, clamav: false },
      ),
    ).toBe(true);
    expect(
      shouldFailForMissingExternalScanner(
        { cliRuntime: "host" },
        { syft: true, grype: false, trivy: false, clamav: false },
      ),
    ).toBe(true);
    expect(
      shouldFailForMissingExternalScanner(
        { cliRuntime: "docker" },
        { syft: false, grype: true, trivy: false, clamav: false },
      ),
    ).toBe(false);
    expect(
      shouldFailForMissingExternalScanner(
        { cliRuntime: "disabled", clamavRestUrl: "http://clamav:3310/scan" },
        { syft: false, grype: false, trivy: false, clamav: true },
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
