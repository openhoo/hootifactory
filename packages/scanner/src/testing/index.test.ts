import { describe, expect, test } from "bun:test";
import type { ScannerPlugin } from "../types";
import {
  createTestContentTarget,
  createTestDependencyTarget,
  createTestScannerRunContext,
  createTestScannerRuntimeOptions,
  resolveTestScanner,
} from "./index";

describe("createTestScannerRuntimeOptions", () => {
  test("defaults to the host runtime with a short timeout", () => {
    expect(createTestScannerRuntimeOptions()).toEqual({ cliRuntime: "host", timeoutMs: 5_000 });
  });

  test("applies overrides over the defaults", () => {
    expect(createTestScannerRuntimeOptions({ cliRuntime: "disabled", dockerCpus: "1" })).toEqual({
      cliRuntime: "disabled",
      timeoutMs: 5_000,
      dockerCpus: "1",
    });
  });
});

describe("createTestScannerRunContext", () => {
  test("wraps the default runtime options", () => {
    expect(createTestScannerRunContext()).toEqual({
      runtime: { cliRuntime: "host", timeoutMs: 5_000 },
    });
  });

  test("threads overrides into the runtime", () => {
    expect(createTestScannerRunContext({ timeoutMs: 1_000 }).runtime.timeoutMs).toBe(1_000);
  });
});

describe("createTestContentTarget", () => {
  test("backs the target with the given bytes and a default path", async () => {
    const bytes = new TextEncoder().encode("payload");
    const target = createTestContentTarget(bytes);
    expect(target.path).toBe("/tmp/hootifactory-test-artifact");
    expect(await target.bytes()).toBe(bytes);
  });

  test("uses a custom path when provided", () => {
    const target = createTestContentTarget(new Uint8Array(), "/var/data/blob");
    expect(target.path).toBe("/var/data/blob");
  });
});

describe("createTestDependencyTarget", () => {
  test("defaults the ecosystem to npm", () => {
    expect(createTestDependencyTarget({ lodash: "1.0.0" })).toEqual({
      ecosystem: "npm",
      deps: { lodash: "1.0.0" },
    });
  });

  test("applies overrides like ecosystem and purlType", () => {
    expect(
      createTestDependencyTarget({ left_pad: "1.0.0" }, { ecosystem: "PyPI", purlType: "pypi" }),
    ).toEqual({ ecosystem: "PyPI", deps: { left_pad: "1.0.0" }, purlType: "pypi" });
  });
});

describe("resolveTestScanner", () => {
  const plugin: ScannerPlugin<{ token: string }> = {
    id: "probe",
    displayName: "probe",
    capabilities: { inputKind: "dependencies", findingTypes: new Set(["vuln"]), network: true },
    configFromEnv: (ctx) => ({ token: ctx.env.TOKEN ?? "" }),
    available: (config) => config.token.length > 0,
    scanDependencies: () => Promise.resolve([]),
  };

  test("resolves config from an empty env by default and probes availability", () => {
    const resolved = resolveTestScanner(plugin);
    expect(resolved.config).toEqual({ token: "" });
    expect(resolved.available).toBe(false);
    expect(resolved.plugin).toBe(plugin);
  });

  test("passes env/runtime/isProduction through to configFromEnv", () => {
    const captured: Array<{ isProduction: boolean; cliRuntime: string | undefined }> = [];
    const recording: ScannerPlugin<{ token: string }> = {
      ...plugin,
      configFromEnv: (ctx) => {
        captured.push({ isProduction: ctx.isProduction, cliRuntime: ctx.runtime.cliRuntime });
        return { token: ctx.env.TOKEN ?? "" };
      },
    };
    const resolved = resolveTestScanner(recording, {
      env: { TOKEN: "secret" },
      runtime: { cliRuntime: "disabled" },
      isProduction: true,
    });
    expect(resolved.available).toBe(true);
    expect(captured).toEqual([{ isProduction: true, cliRuntime: "disabled" }]);
  });
});
