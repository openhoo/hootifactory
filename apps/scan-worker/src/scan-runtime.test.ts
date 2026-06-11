import { describe, expect, test } from "bun:test";
import type { ResolvedScanner, ScannerRuntime, ScannerRuntimeOptions } from "@hootifactory/scanner";
import {
  externalContentScannerAvailable,
  externalContentScannerRequested,
  scannerCliRunsOnHost,
  scannerRuntimeFromEnv,
  shouldFailForMissingExternalScanner,
  unavailableExternalScannerMessage,
  unsandboxedScannerRuntimeWarning,
} from "./scan-runtime";

function scanner(
  id: string,
  opts: {
    inputKind?: "content" | "dependencies";
    available?: boolean;
    requiresExternalRuntime?: boolean;
    displayName?: string;
  } = {},
): ResolvedScanner {
  const inputKind = opts.inputKind ?? "content";
  const available = opts.available ?? false;
  return {
    plugin: {
      id,
      displayName: opts.displayName ?? id,
      capabilities: { inputKind, findingTypes: new Set(["vuln"]), network: false },
      configFromEnv: () => null,
      available: () => available,
      requiresExternalRuntime: () => opts.requiresExternalRuntime ?? false,
      scanContent: () => Promise.resolve([]),
    },
    config: null,
    available,
  };
}

function runtime(options: ScannerRuntimeOptions, scanners: ResolvedScanner[]): ScannerRuntime {
  return { options, scanners };
}

describe("scannerRuntimeFromEnv", () => {
  test("builds a runtime from the environment with a scanners list and options", () => {
    const rt = scannerRuntimeFromEnv();
    expect(Array.isArray(rt.scanners)).toBe(true);
    expect(typeof rt.options).toBe("object");
  });
});

describe("externalContentScannerAvailable", () => {
  test("is true only when a content scanner is actually available", () => {
    expect(
      externalContentScannerAvailable(runtime({}, [scanner("grype", { available: true })])),
    ).toBe(true);
    expect(
      externalContentScannerAvailable(runtime({}, [scanner("grype", { available: false })])),
    ).toBe(false);
    // dependency-input scanners do not count as content scanners
    expect(
      externalContentScannerAvailable(
        runtime({}, [scanner("osv", { inputKind: "dependencies", available: true })]),
      ),
    ).toBe(false);
  });
});

describe("externalContentScannerRequested", () => {
  test("defaults to docker runtime (requested) when cliRuntime is unset", () => {
    expect(externalContentScannerRequested(runtime({}, []))).toBe(true);
  });

  test("is not requested when the CLI runtime is disabled and nothing needs an endpoint", () => {
    expect(externalContentScannerRequested(runtime({ cliRuntime: "disabled" }, []))).toBe(false);
  });

  test("is requested when a content scanner needs an external runtime even if CLI is disabled", () => {
    expect(
      externalContentScannerRequested(
        runtime({ cliRuntime: "disabled" }, [scanner("clamav", { requiresExternalRuntime: true })]),
      ),
    ).toBe(true);
  });
});

describe("shouldFailForMissingExternalScanner", () => {
  test("fails closed when external scanning is requested but no content scanner is available", () => {
    expect(
      shouldFailForMissingExternalScanner(
        runtime({ cliRuntime: "docker" }, [scanner("grype", { available: false })]),
      ),
    ).toBe(true);
  });

  test("does not fail when a content scanner is available", () => {
    expect(
      shouldFailForMissingExternalScanner(
        runtime({ cliRuntime: "docker" }, [scanner("grype", { available: true })]),
      ),
    ).toBe(false);
  });

  test("does not fail when external scanning was never requested", () => {
    expect(shouldFailForMissingExternalScanner(runtime({ cliRuntime: "disabled" }, []))).toBe(
      false,
    );
  });
});

describe("unavailableExternalScannerMessage", () => {
  test("names the configured cli runtime and the content scanner display names", () => {
    const message = unavailableExternalScannerMessage(
      runtime({ cliRuntime: "host" }, [
        scanner("grype", { displayName: "Grype" }),
        scanner("clamav", { displayName: "ClamAV" }),
      ]),
    );
    expect(message).toContain("SCANNER_CLI_RUNTIME=host");
    expect(message).toContain("Grype, ClamAV");
    expect(message).toContain("external content scanning is configured");
  });

  test("defaults the runtime label to docker and omits the scanner suffix when none exist", () => {
    const message = unavailableExternalScannerMessage(runtime({}, []));
    expect(message).toContain("SCANNER_CLI_RUNTIME=docker");
    expect(message).not.toContain("()");
  });
});

describe("scannerCliRunsOnHost", () => {
  test("host mode always runs on the host", () => {
    expect(scannerCliRunsOnHost({ cliRuntime: "host" })).toBe(true);
  });

  test("docker and disabled modes never run on the host", () => {
    expect(scannerCliRunsOnHost({ cliRuntime: "docker" })).toBe(false);
    expect(scannerCliRunsOnHost({ cliRuntime: "disabled" })).toBe(false);
    // The unset default is docker.
    expect(scannerCliRunsOnHost({})).toBe(false);
  });

  test("auto falls back to host binaries when the Docker CLI is unavailable", () => {
    expect(
      scannerCliRunsOnHost({
        cliRuntime: "auto",
        dockerCommand: "definitely-not-a-docker-cli-on-path",
      }),
    ).toBe(true);
  });
});

describe("unsandboxedScannerRuntimeWarning", () => {
  test("warns for host mode and spells out what is lost", () => {
    const warning = unsandboxedScannerRuntimeWarning({ cliRuntime: "host" });
    expect(warning).toContain("unsandboxed");
    expect(warning).toContain("SCANNER_TIMEOUT_MS");
    expect(warning).toContain("SCANNER_CLI_RUNTIME=docker");
  });

  test("stays silent for sandboxed or disabled runtimes", () => {
    expect(unsandboxedScannerRuntimeWarning({ cliRuntime: "docker" })).toBeNull();
    expect(unsandboxedScannerRuntimeWarning({ cliRuntime: "disabled" })).toBeNull();
    expect(unsandboxedScannerRuntimeWarning({})).toBeNull();
  });
});
