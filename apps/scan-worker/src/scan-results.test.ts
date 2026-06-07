import { afterEach, describe, expect, mock, test } from "bun:test";
import type { NormalizedFinding } from "@hootifactory/scan-core";

/**
 * scan-results.ts is the persistence layer for the scan pipeline. It is exercised
 * here without a database by stubbing `@hootifactory/db`'s `db` handle with a
 * chainable, awaitable recorder that captures every builder call and the row
 * payloads, while keeping the real table objects + operators (`eq`, `sql`) so the
 * production WHERE/INSERT wiring runs unmodified.
 */

interface BuilderCall {
  method: string;
  args: unknown[];
}

interface DbRecorder {
  calls: BuilderCall[];
  insertValues: unknown[][];
  selectResult: unknown[];
  insertReturning: unknown[];
}

/**
 * Builds a stub `db` whose chains resolve to a configurable result. `select`
 * chains resolve to `selectResult`; chains that end in `.returning(...)` resolve
 * to `insertReturning`; every other awaited chain resolves to an empty array.
 */
function makeDb(opts: { selectResult?: unknown[]; insertReturning?: unknown[] } = {}): {
  db: unknown;
  recorder: DbRecorder;
} {
  const recorder: DbRecorder = {
    calls: [],
    insertValues: [],
    selectResult: opts.selectResult ?? [],
    insertReturning: opts.insertReturning ?? [],
  };

  function chain(kind: "select" | "write"): unknown {
    let sawReturning = false;
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    const proxy: unknown = new Proxy(builder, {
      get(_t, prop) {
        if (prop === "then") {
          const value =
            kind === "select"
              ? recorder.selectResult
              : sawReturning
                ? recorder.insertReturning
                : [];
          return (resolve: (v: unknown) => unknown) => resolve(value);
        }
        return (...args: unknown[]) => {
          recorder.calls.push({ method: String(prop), args });
          if (prop === "values") recorder.insertValues.push(args[0] as unknown[]);
          if (prop === "returning") sawReturning = true;
          return proxy;
        };
      },
    });
    return proxy;
  }

  const db = {
    insert: (...args: unknown[]) => {
      recorder.calls.push({ method: "insert", args });
      return chain("write");
    },
    update: (...args: unknown[]) => {
      recorder.calls.push({ method: "update", args });
      return chain("write");
    },
    delete: (...args: unknown[]) => {
      recorder.calls.push({ method: "delete", args });
      return chain("write");
    },
    select: (...args: unknown[]) => {
      recorder.calls.push({ method: "select", args });
      return chain("select");
    },
  };
  return { db, recorder };
}

async function loadModule(dbStub: unknown) {
  const real = await import("@hootifactory/db");
  await mock.module("@hootifactory/db", () => ({ ...real, db: dbStub }));
  return import("./scan-results");
}

const artifact = {
  id: "art-1",
  digest: "sha256:abc",
  repositoryId: "repo-1",
  name: "demo",
  version: "1.0.0",
} as never;

const repo = { id: "repo-1", name: "demo-repo", orgId: "org-1" } as never;

afterEach(() => {
  mock.restore();
});

describe("persistScanResult", () => {
  test("upserts the scan row, deletes old findings, and inserts new findings", async () => {
    const { db, recorder } = makeDb({ insertReturning: [{ id: "scan-1" }] });
    const { persistScanResult } = await loadModule(db);

    const findings: NormalizedFinding[] = [
      {
        type: "vuln",
        vulnId: "CVE-1",
        purl: "pkg:npm/a@1.0.0",
        packageName: "a",
        severity: "high",
        cvssScore: 7.1,
      },
    ];
    await persistScanResult(artifact, findings, ["grype", "osv"]);

    const methods = recorder.calls.map((c) => c.method);
    expect(methods).toContain("insert");
    expect(methods).toContain("onConflictDoUpdate");
    expect(methods).toContain("returning");
    // old findings are cleared before new ones are written
    expect(methods).toContain("delete");
    expect(methods.indexOf("delete")).toBeLessThan(methods.lastIndexOf("values"));

    // the scan row carries the scanners that ran (a single values() object)
    const scanRow = recorder.insertValues[0] as unknown as Record<string, unknown>;
    expect(scanRow.artifactId).toBe("art-1");
    expect(scanRow.blobDigest).toBe("sha256:abc");
    expect(scanRow.sbomNativeJson).toEqual({ scanners: ["grype", "osv"] });

    // findings rows mirror the normalized findings
    const findingRows = recorder.insertValues[1] as Record<string, unknown>[];
    expect(findingRows).toHaveLength(1);
    expect(findingRows[0]).toMatchObject({
      scanId: "scan-1",
      artifactId: "art-1",
      vulnId: "CVE-1",
      severity: "high",
      cvssScore: 7.1,
      data: null,
    });
  });

  test("skips the findings insert when there are no findings", async () => {
    const { db, recorder } = makeDb({ insertReturning: [{ id: "scan-2" }] });
    const { persistScanResult } = await loadModule(db);

    await persistScanResult(artifact, [], ["grype"]);
    // only the scan upsert inserts; no second values() for findings
    expect(recorder.insertValues).toHaveLength(1);
    expect(recorder.calls.map((c) => c.method)).toContain("delete");
  });

  test("does not touch findings when the upsert returns no scan id", async () => {
    const { db, recorder } = makeDb({ insertReturning: [] });
    const { persistScanResult } = await loadModule(db);

    await persistScanResult(artifact, [{ type: "vuln", severity: "low" }], ["grype"]);
    // no delete/insert of findings without a scan id
    expect(recorder.calls.map((c) => c.method)).not.toContain("delete");
    expect(recorder.insertValues).toHaveLength(1);
  });
});

describe("applyPolicyDecision", () => {
  test("loads the policy, evaluates findings, and writes the artifact state", async () => {
    const { db, recorder } = makeDb();
    const realApp = await import("@hootifactory/registry-application/governance");
    await mock.module("@hootifactory/registry-application/governance", () => ({
      ...realApp,
      resolveRegistryScanPolicy: async () => ({ mode: "enforce", blockOnSeverity: "medium" }),
    }));
    const { applyPolicyDecision } = await loadModule(db);

    await applyPolicyDecision(artifact, repo, [{ type: "vuln", severity: "high", cvssScore: 8 }]);

    const update = recorder.calls.find((c) => c.method === "set");
    const payload = update?.args[0] as { state: string; policyDecision: Record<string, unknown> };
    expect(payload.state).toBe("blocked");
    expect(payload.policyDecision.highest).toBe("high");
    expect(payload.policyDecision.findings).toBe(1);
    expect(payload.policyDecision.mode).toBe("enforce");
  });

  test("marks clean when no policy is configured and there are no findings", async () => {
    const { db, recorder } = makeDb();
    const realApp = await import("@hootifactory/registry-application/governance");
    await mock.module("@hootifactory/registry-application/governance", () => ({
      ...realApp,
      resolveRegistryScanPolicy: async () => null,
    }));
    const { applyPolicyDecision } = await loadModule(db);

    await applyPolicyDecision(artifact, repo, []);
    const update = recorder.calls.find((c) => c.method === "set");
    const payload = update?.args[0] as { state: string };
    expect(payload.state).toBe("clean");
  });
});

describe("markSkippedClean", () => {
  test("sets the artifact clean with the skip reason", async () => {
    const { db, recorder } = makeDb();
    const { markSkippedClean } = await loadModule(db);

    await markSkippedClean(artifact, "package_version_deleted");
    const update = recorder.calls.find((c) => c.method === "set");
    const payload = update?.args[0] as { state: string; policyDecision: Record<string, unknown> };
    expect(payload.state).toBe("clean");
    expect(payload.policyDecision).toEqual({ skipped: "package_version_deleted", findings: 0 });
    expect(recorder.calls.map((c) => c.method)).toContain("update");
  });
});

describe("recordScanFailure", () => {
  test("no-ops when the artifact no longer exists", async () => {
    const { db, recorder } = makeDb({ selectResult: [] });
    const { recordScanFailure } = await loadModule(db);

    await recordScanFailure("missing-art", new Error("boom"));
    // only the lookup select ran; no failed-scan insert/update
    expect(recorder.calls.map((c) => c.method)).toEqual(["select", "from", "where", "limit"]);
  });

  test("upserts a failed scan row and records the failure on the artifact", async () => {
    const { db, recorder } = makeDb({ selectResult: [artifact] });
    const { recordScanFailure } = await loadModule(db);

    await recordScanFailure("art-1", new Error("scanner crashed"));
    const methods = recorder.calls.map((c) => c.method);
    expect(methods).toContain("insert");
    expect(methods).toContain("onConflictDoUpdate");
    expect(methods).toContain("update");

    const failedScan = recorder.insertValues[0] as unknown as Record<string, unknown>;
    expect(failedScan.status).toBe("failed");
    expect(failedScan.error).toBe("scanner crashed");

    const update = recorder.calls.find((c) => c.method === "set");
    const decision = (update?.args[0] as { policyDecision: Record<string, unknown> })
      .policyDecision;
    expect(decision.scanStatus).toBe("failed");
    expect(decision.error).toBe("scanner crashed");
  });

  test("stringifies and truncates non-Error failures", async () => {
    const { db, recorder } = makeDb({ selectResult: [artifact] });
    const { recordScanFailure } = await loadModule(db);

    const long = "x".repeat(5000);
    await recordScanFailure("art-1", long);
    const failedScan = recorder.insertValues[0] as unknown as Record<string, unknown>;
    expect((failedScan.error as string).length).toBe(2000);
  });
});
