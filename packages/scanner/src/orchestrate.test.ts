import { describe, expect, test } from "bun:test";
import type { NormalizedFinding } from "@hootifactory/scan-core";
import {
  resolveScanners,
  runContentScanners,
  runDependencyScanners,
  streamConsumersFor,
} from "./orchestrate";
import type {
  ContentScanTarget,
  DependencyScanTarget,
  ResolvedScanner,
  ScannerPlugin,
  ScannerRunContext,
  ScannerStreamConsumer,
} from "./types";

const RUN_CTX: ScannerRunContext = { runtime: { cliRuntime: "host" } };

function vulnFinding(id: string): NormalizedFinding {
  return { type: "vuln", vulnId: id, severity: "high" };
}

function depPlugin(id: string, scan: ScannerPlugin["scanDependencies"]): ScannerPlugin<null> {
  return {
    id,
    displayName: id,
    capabilities: { inputKind: "dependencies", findingTypes: new Set(["vuln"]), network: false },
    configFromEnv: () => null,
    available: () => true,
    scanDependencies: scan,
  };
}

function contentPlugin(id: string, scan: ScannerPlugin["scanContent"]): ScannerPlugin<null> {
  return {
    id,
    displayName: id,
    capabilities: { inputKind: "content", findingTypes: new Set(["vuln"]), network: false },
    configFromEnv: () => null,
    available: () => true,
    scanContent: scan,
  };
}

function resolved<T = null>(
  plugin: ScannerPlugin<T>,
  config: T,
  available = true,
): ResolvedScanner<T> {
  return { plugin, config, available };
}

describe("resolveScanners", () => {
  test("resolves config from the env and probes availability once per plugin", () => {
    const seen: Array<{ env: Record<string, string | undefined>; isProduction: boolean }> = [];
    const plugin: ScannerPlugin<{ token: string }> = {
      id: "with-config",
      displayName: "with-config",
      capabilities: { inputKind: "dependencies", findingTypes: new Set(["vuln"]), network: true },
      configFromEnv: (ctx) => {
        seen.push({ env: ctx.env, isProduction: ctx.isProduction });
        return { token: ctx.env.TOKEN ?? "" };
      },
      available: (config) => config.token.length > 0,
      scanDependencies: () => Promise.resolve([]),
    };

    const resolvedScanners = resolveScanners([plugin], {
      env: { TOKEN: "secret" },
      runtime: { cliRuntime: "host" },
      isProduction: true,
    });

    expect(resolvedScanners).toHaveLength(1);
    expect(resolvedScanners[0]?.config).toEqual({ token: "secret" });
    expect(resolvedScanners[0]?.available).toBe(true);
    expect(seen).toEqual([{ env: { TOKEN: "secret" }, isProduction: true }]);
  });

  test("marks a scanner unavailable when its probe returns false", () => {
    const plugin = depPlugin("offline", () => Promise.resolve([]));
    const [first] = resolveScanners([{ ...plugin, available: () => false }], {
      env: {},
      runtime: {},
      isProduction: false,
    });
    expect(first?.available).toBe(false);
  });
});

describe("streamConsumersFor", () => {
  test("creates one consumer per available stream scanner, skipping others", () => {
    const consumer: ScannerStreamConsumer = { update: () => {}, findings: () => [] };
    const streamScanner: ScannerPlugin<null> = {
      id: "stream",
      displayName: "stream",
      capabilities: { inputKind: "stream", findingTypes: new Set(["malware"]), network: false },
      configFromEnv: () => null,
      available: () => true,
      createStreamConsumer: () => consumer,
    };
    const noFactory: ScannerPlugin<null> = { ...streamScanner, id: "no-factory" };
    delete (noFactory as { createStreamConsumer?: unknown }).createStreamConsumer;

    const out = streamConsumersFor([
      resolved(streamScanner, null),
      resolved(streamScanner, null, false), // unavailable, skipped
      resolved(noFactory, null), // no factory, skipped
      resolved(
        depPlugin("dep", () => Promise.resolve([])),
        null,
      ), // wrong kind, skipped
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]?.scanner.plugin.id).toBe("stream");
    expect(out[0]?.consumer).toBe(consumer);
  });
});

describe("runContentScanners", () => {
  const target: ContentScanTarget = {
    path: "/tmp/artifact",
    bytes: () => Promise.resolve(new Uint8Array()),
  };

  test("fans available content scanners out and aggregates findings", async () => {
    const result = await runContentScanners(
      [
        resolved(
          contentPlugin("a", () => Promise.resolve([vulnFinding("A")])),
          null,
        ),
        resolved(
          contentPlugin("b", () => Promise.resolve([vulnFinding("B")])),
          null,
        ),
        resolved(
          contentPlugin("c", () => Promise.resolve([])),
          null,
          false,
        ), // unavailable
        resolved(
          depPlugin("dep", () => Promise.resolve([vulnFinding("D")])),
          null,
        ), // wrong kind
      ],
      target,
      RUN_CTX,
    );

    expect(result.attempted.sort()).toEqual(["a", "b"]);
    expect(result.findings.map((f) => f.vulnId).sort()).toEqual(["A", "B"]);
    expect(result.errors).toEqual([]);
  });

  test("treats a missing scanContent entry point as an empty result", async () => {
    const noEntry = contentPlugin("no-entry", () => Promise.resolve([]));
    delete (noEntry as { scanContent?: unknown }).scanContent;
    const result = await runContentScanners([resolved(noEntry, null)], target, RUN_CTX);
    expect(result.attempted).toEqual(["no-entry"]);
    expect(result.findings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("isolates a failing scanner: healthy findings survive, the failure is reported", async () => {
    const result = await runContentScanners(
      [
        resolved(
          contentPlugin("ok", () => Promise.resolve([vulnFinding("OK")])),
          null,
        ),
        resolved(
          contentPlugin("boom", () => Promise.reject(new Error("scanner exploded"))),
          null,
        ),
      ],
      target,
      RUN_CTX,
    );

    expect(result.findings.map((f) => f.vulnId)).toEqual(["OK"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.scanner).toBe("boom");
    expect((result.errors[0]?.error as Error).message).toBe("scanner exploded");
    expect(result.attempted.sort()).toEqual(["boom", "ok"]);
  });
});

describe("runDependencyScanners", () => {
  const target: DependencyScanTarget = { ecosystem: "npm", deps: { lodash: "1.0.0" } };

  test("fans available dependency scanners out over the resolved dependency set", async () => {
    const result = await runDependencyScanners(
      [
        resolved(
          depPlugin("d1", () => Promise.resolve([vulnFinding("V1")])),
          null,
        ),
        resolved(
          contentPlugin("c1", () => Promise.resolve([])),
          null,
        ), // wrong kind
      ],
      target,
      RUN_CTX,
    );
    expect(result.attempted).toEqual(["d1"]);
    expect(result.findings.map((f) => f.vulnId)).toEqual(["V1"]);
  });

  test("returns empty attempted set when nothing is available", async () => {
    const result = await runDependencyScanners(
      [
        resolved(
          depPlugin("d1", () => Promise.resolve([])),
          null,
          false,
        ),
      ],
      target,
      RUN_CTX,
    );
    expect(result.attempted).toEqual([]);
    expect(result.findings).toEqual([]);
  });
});
