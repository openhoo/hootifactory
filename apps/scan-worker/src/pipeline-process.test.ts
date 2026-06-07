import { describe, expect, test } from "bun:test";
import type { NormalizedFinding } from "@hootifactory/scan-core";
import type { ScannerRuntime } from "@hootifactory/scanner";

/**
 * Drives processScan (and its private processScanInner) end-to-end without a
 * database or real scanners. The DB is supplied through processScan's injectable
 * `db` seam (a fake select builder) so the orchestration never opens a real
 * connection — rather than mocking the process-global @hootifactory/db module,
 * which raced the real handle in CI. The registry-plugin lookup, the CAS manifest
 * loader, and the worker's own collaborator modules (scan-bytes /
 * scan-dependencies / scan-results) are stubbed because they are pure in-memory
 * fakes that touch no real backend. Each test asserts which persistence path the
 * orchestration drives for a given artifact shape.
 */

interface Recorded {
  scanStoredBytesCalls: string[];
  dependencyTargets: unknown[];
  manifestLoads: string[];
  persisted: { findings: NormalizedFinding[]; scanners: readonly string[] } | null;
  policyApplied: { findings: NormalizedFinding[] } | null;
  skipped: string | null;
}

const runtime = {
  options: {},
  scanners: [
    {
      plugin: {
        id: "heuristic",
        displayName: "heuristic",
        capabilities: {
          inputKind: "dependencies",
          findingTypes: new Set(["vuln"]),
          network: false,
        },
        configFromEnv: () => null,
        available: () => true,
        scanDependencies: () => Promise.resolve([]),
      },
      config: null,
      available: true,
    },
  ],
} as unknown as ScannerRuntime;

const artifactRow = {
  id: "art-1",
  digest: "sha256:abc",
  repositoryId: "repo-1",
  name: "demo",
  version: "1.0.0",
};
const repoRow = {
  id: "repo-1",
  name: "demo-repo",
  orgId: "org-1",
  moduleId: "test",
};

/** db.select() chain whose awaited result is read from a queue of result sets. */
function makeDb(selectResults: unknown[][]): unknown {
  let call = 0;
  function chain(): unknown {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const value = selectResults[call] ?? [];
            call += 1;
            return (resolve: (v: unknown) => unknown) => resolve(value);
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  }
  return { select: () => chain() };
}

interface SetupOpts {
  selectResults: unknown[][];
  module?: unknown;
  scanStoredBytes?: (digest: string) => Promise<{
    available: boolean;
    scannedPayload: boolean;
    findings: NormalizedFinding[];
  }>;
  deps?: { deps: Record<string, string>; osvEcosystem: string; purlType?: string };
  manifest?: (digest: string) => Promise<{ raw: string } | null>;
}

/** processScan bound to the test's fully-injected collaborators (no module mocks). */
type BoundProcessScan = (artifactId: string, scannerRuntime: ScannerRuntime) => Promise<void>;

async function setup(
  opts: SetupOpts,
): Promise<{ recorded: Recorded; processScan: BoundProcessScan }> {
  const recorded: Recorded = {
    scanStoredBytesCalls: [],
    dependencyTargets: [],
    manifestLoads: [],
    persisted: null,
    policyApplied: null,
    skipped: null,
  };

  // Every backend + collaborator is injected through processScan's `deps` seam, so
  // the orchestration touches no real DB/S3 and no process-global module mock can
  // leak into (or out of) this file's parallel siblings.
  const deps: import("./pipeline").ScanPipelineDeps = {
    db: makeDb(opts.selectResults) as typeof import("@hootifactory/db").db,
    lookupRegistryPlugin: () =>
      opts.module as ReturnType<
        NonNullable<import("./pipeline").ScanPipelineDeps["lookupRegistryPlugin"]>
      >,
    loadContentAddressableManifestRaw: (async ({ digest }: { digest: string }) => {
      recorded.manifestLoads.push(digest);
      return opts.manifest ? opts.manifest(digest) : null;
    }) as import("./pipeline").ScanPipelineDeps["loadContentAddressableManifestRaw"],
    scanStoredBytes: (async (input: { digest: string }) => {
      recorded.scanStoredBytesCalls.push(input.digest);
      return (
        opts.scanStoredBytes?.(input.digest) ?? {
          available: false,
          scannedPayload: false,
          findings: [],
        }
      );
    }) as import("./pipeline").ScanPipelineDeps["scanStoredBytes"],
    collectPackageDependencies: (async (target: unknown) => {
      recorded.dependencyTargets.push(target);
      return opts.deps ?? { deps: {}, osvEcosystem: "" };
    }) as import("./pipeline").ScanPipelineDeps["collectPackageDependencies"],
    persistScanResult: (async (
      _art: unknown,
      findings: NormalizedFinding[],
      scanners: readonly string[],
    ) => {
      recorded.persisted = { findings, scanners };
    }) as import("./pipeline").ScanPipelineDeps["persistScanResult"],
    applyPolicyDecision: (async (_art: unknown, _repo: unknown, findings: NormalizedFinding[]) => {
      recorded.policyApplied = { findings };
    }) as import("./pipeline").ScanPipelineDeps["applyPolicyDecision"],
    markSkippedClean: (async (_art: unknown, reason: string) => {
      recorded.skipped = reason;
    }) as import("./pipeline").ScanPipelineDeps["markSkippedClean"],
  };

  const { processScan } = await import("./pipeline");
  const boundProcessScan: BoundProcessScan = (artifactId, scannerRuntime) =>
    processScan(artifactId, scannerRuntime, deps);
  return { recorded, processScan: boundProcessScan };
}

const moduleNoScan = {
  id: "test",
  scan: undefined,
};

describe("processScan orchestration", () => {
  test("returns early when the artifact does not exist", async () => {
    const { recorded, processScan } = await setup({ selectResults: [[]] });
    await processScan("missing", runtime);
    expect(recorded.persisted).toBeNull();
    expect(recorded.policyApplied).toBeNull();
  });

  test("returns early when the repository is missing", async () => {
    const { recorded, processScan } = await setup({ selectResults: [[artifactRow], []] });
    await processScan("art-1", runtime);
    expect(recorded.persisted).toBeNull();
  });

  test("throws when the registry module is not registered", async () => {
    const { processScan } = await setup({
      selectResults: [[artifactRow], [repoRow]],
      module: undefined,
    });
    await expect(processScan("art-1", runtime)).rejects.toThrow(
      "registry module is not registered",
    );
  });

  test("scans direct bytes then persists and applies policy", async () => {
    const finding: NormalizedFinding = { type: "vuln", severity: "high", vulnId: "CVE-1" };
    const { recorded, processScan } = await setup({
      selectResults: [[artifactRow], [repoRow]],
      module: moduleNoScan,
      scanStoredBytes: async () => ({
        available: true,
        scannedPayload: true,
        findings: [finding],
      }),
    });
    await processScan("art-1", runtime);
    expect(recorded.scanStoredBytesCalls).toEqual(["sha256:abc"]);
    expect(recorded.persisted?.findings).toEqual([finding]);
    expect(recorded.persisted?.scanners).toEqual(["heuristic"]);
    expect(recorded.policyApplied?.findings).toEqual([finding]);
    expect(recorded.skipped).toBeNull();
  });

  test("throws when no scannable bytes and no deps and the version is not deleted", async () => {
    // selects: artifact, repo, (isDeletedPackageVersion → empty)
    const { processScan } = await setup({
      selectResults: [[artifactRow], [repoRow], []],
      module: moduleNoScan,
      scanStoredBytes: async () => ({ available: false, scannedPayload: false, findings: [] }),
    });
    await expect(processScan("art-1", runtime)).rejects.toThrow("no scannable bytes available");
  });

  test("marks clean+skipped when the package version was deleted", async () => {
    const { recorded, processScan } = await setup({
      selectResults: [[artifactRow], [repoRow], [{ deletedAt: new Date() }]],
      module: moduleNoScan,
      scanStoredBytes: async () => ({ available: false, scannedPayload: false, findings: [] }),
    });
    await processScan("art-1", runtime);
    expect(recorded.skipped).toBe("package_version_deleted");
    expect(recorded.persisted).toBeNull();
  });

  test("walks the manifest graph when there are no direct bytes", async () => {
    const blobFinding: NormalizedFinding = { type: "malware", severity: "critical", title: "x" };
    const moduleWithGraph = {
      id: "test",
      scan: {
        contentAddressableManifestGraph: {
          noPayloadReason: "oci_no_payload",
          references: (raw: string) =>
            raw === "root"
              ? { blobs: ["sha256:layer"], manifests: [] }
              : { blobs: [], manifests: [] },
        },
      },
    };
    const { recorded, processScan } = await setup({
      selectResults: [[artifactRow], [repoRow]],
      module: moduleWithGraph,
      // direct digest has no bytes (allowMissing), layer digest yields a finding
      scanStoredBytes: async (digest) =>
        digest === "sha256:layer"
          ? { available: true, scannedPayload: true, findings: [blobFinding] }
          : { available: false, scannedPayload: false, findings: [] },
      manifest: async (digest) => (digest === "sha256:abc" ? { raw: "root" } : null),
    });
    await processScan("art-1", runtime);
    expect(recorded.manifestLoads).toContain("sha256:abc");
    expect(recorded.scanStoredBytesCalls).toContain("sha256:layer");
    expect(recorded.persisted?.findings).toEqual([blobFinding]);
  });

  test("marks clean+skipped when the manifest graph has no scannable payload", async () => {
    const moduleEmptyGraph = {
      id: "test",
      scan: {
        contentAddressableManifestGraph: {
          noPayloadReason: "oci_no_payload",
          references: () => ({ blobs: [], manifests: [] }),
        },
      },
    };
    const { recorded, processScan } = await setup({
      // artifact, repo, isDeletedPackageVersion (not deleted)
      selectResults: [[artifactRow], [repoRow], []],
      module: moduleEmptyGraph,
      scanStoredBytes: async () => ({ available: false, scannedPayload: false, findings: [] }),
      manifest: async () => ({ raw: "root" }),
    });
    await processScan("art-1", runtime);
    expect(recorded.skipped).toBe("oci_no_payload");
  });

  test("merges dependency-scanner findings with byte findings before persisting", async () => {
    const { recorded, processScan } = await setup({
      selectResults: [[artifactRow], [repoRow]],
      module: moduleNoScan,
      scanStoredBytes: async () => ({
        available: true,
        scannedPayload: true,
        findings: [{ type: "secret", severity: "low", title: "tok" }],
      }),
      deps: { deps: { leftpad: "1.0.0" }, osvEcosystem: "npm" },
    });
    await processScan("art-1", runtime);
    // the dependency target was built from the artifact + repo
    expect(recorded.dependencyTargets).toHaveLength(1);
    expect(recorded.persisted?.findings.map((f) => f.type)).toEqual(["secret"]);
  });
});
