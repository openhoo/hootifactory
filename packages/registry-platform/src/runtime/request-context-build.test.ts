import { afterEach, describe, expect, mock, test } from "bun:test";

function fakeDb(rowsByCall: unknown[][] = []) {
  const calls: { op: string; args: unknown[] }[] = [];
  let resolveCount = 0;
  const handler: ProxyHandler<(...a: unknown[]) => unknown> = {
    get(_t, prop) {
      if (prop === "then") {
        const rows = rowsByCall[resolveCount] ?? rowsByCall[rowsByCall.length - 1] ?? [];
        resolveCount += 1;
        return (resolve: (v: unknown) => unknown) => resolve(rows);
      }
      if (prop === "transaction") {
        return (cb: (tx: unknown) => Promise<unknown>) => cb(builder);
      }
      return (...args: unknown[]) => {
        calls.push({ op: String(prop), args });
        return builder;
      };
    },
    apply() {
      return builder;
    },
  };
  const builder: any = new Proxy(() => {}, handler);
  return { builder, calls };
}

async function withFakeDb<T>(
  rowsByCall: unknown[][],
  run: (calls: { op: string; args: unknown[] }[]) => Promise<T>,
): Promise<T> {
  const realDb = await import("@hootifactory/db");
  const { builder, calls } = fakeDb(rowsByCall);
  await mock.module("@hootifactory/db", () => ({ ...realDb, db: builder }));
  return run(calls);
}

const DIGEST = `sha256:${"ab".repeat(32)}`;

const repo = {
  id: "repo_1",
  orgId: "org_1",
  name: "packages",
  kind: "hosted",
  visibility: "private",
  moduleId: "npm",
  mountPath: "npm/acme/packages",
} as any;

describe("recordArtifactScanOutbox", () => {
  afterEach(() => mock.restore());

  test("upserts the artifact + outbox and returns the artifact id", async () => {
    const result = await withFakeDb([[{ id: "art_1" }], []], async (calls) => {
      const { recordArtifactScanOutbox } = await import("./request-context");
      const r = await recordArtifactScanOutbox(repo, {
        digest: DIGEST,
        mediaType: "application/octet-stream",
        name: "demo",
        version: "1.0.0",
      });
      // Two upserts: the artifact row and the scan_outbox row.
      expect(calls.filter((c) => c.op === "onConflictDoUpdate")).toHaveLength(2);
      return r;
    });
    expect(result).toEqual({ artifactId: "art_1" });
  });

  test("rejects a malformed digest before touching the database (issue #308)", async () => {
    await withFakeDb([[{ id: "art_1" }], []], async (calls) => {
      const [{ recordArtifactScanOutbox }, { InvalidDigestError }] = await Promise.all([
        import("./request-context"),
        import("@hootifactory/core"),
      ]);
      await expect(
        recordArtifactScanOutbox(repo, {
          digest: "sha256:not-a-digest",
          name: "demo",
          version: "1.0.0",
        }),
      ).rejects.toBeInstanceOf(InvalidDigestError);
      // The assertion fires before the transaction opens: nothing was inserted.
      expect(calls).toHaveLength(0);
    });
  });

  test("stamps the captured telemetry carrier on the outbox row (issue #341)", async () => {
    const carrier = {
      trace: { traceparent: "00-abc-def-01" },
      requestId: "req-1",
      correlationId: "corr-1",
    };
    await withFakeDb([[{ id: "art_1" }], []], async (calls) => {
      const { recordArtifactScanOutbox } = await import("./request-context");
      await recordArtifactScanOutbox(
        repo,
        { digest: "sha256:ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12" },
        () => carrier,
      );
      // The second insert is the scan_outbox row: its values carry the carrier...
      const values = calls.filter((c) => c.op === "values");
      const outboxValues = values[1]?.args[0] as { telemetry?: unknown } | undefined;
      expect(outboxValues?.telemetry).toEqual(carrier);
      // ...and so does the conflict-update set, so a re-publish re-links the
      // rescan to the trace that requested it.
      const conflicts = calls.filter((c) => c.op === "onConflictDoUpdate");
      const outboxSet = conflicts[1]?.args[0] as { set?: { telemetry?: unknown } } | undefined;
      expect(outboxSet?.set?.telemetry).toEqual(carrier);
    });
  });

  test("stores NULL telemetry when there is no context to link (issue #341)", async () => {
    await withFakeDb([[{ id: "art_1" }], []], async (calls) => {
      const { recordArtifactScanOutbox } = await import("./request-context");
      await recordArtifactScanOutbox(
        repo,
        { digest: "sha256:ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12" },
        () => ({}),
      );
      const values = calls.filter((c) => c.op === "values");
      const outboxValues = values[1]?.args[0] as { telemetry?: unknown } | undefined;
      expect(outboxValues?.telemetry).toBeNull();
    });
  });

  test("returns null when the artifact upsert yields no row", async () => {
    const result = await withFakeDb([[]], async (calls) => {
      const { recordArtifactScanOutbox } = await import("./request-context");
      const r = await recordArtifactScanOutbox(repo, { digest: DIGEST });
      // Without an artifact row, the outbox upsert must not run.
      expect(calls.filter((c) => c.op === "onConflictDoUpdate")).toHaveLength(1);
      return r;
    });
    expect(result).toBeNull();
  });
});

describe("buildRegistryRequestContext", () => {
  afterEach(() => mock.restore());

  test("assembles a context with limits, an authorizer, and a wired data service", async () => {
    const realAuth = await import("@hootifactory/auth");
    let authorizeArgs: unknown[] | undefined;
    await mock.module("@hootifactory/auth", () => ({
      ...realAuth,
      createRequestAuthorizer: () => (action: unknown, resource: unknown) => {
        authorizeArgs = [action, resource];
        return { allowed: true };
      },
    }));
    await withFakeDb([[]], async () => {
      const { buildRegistryRequestContext } = await import("./request-context");
      const ctx = buildRegistryRequestContext(repo, { kind: "user", userId: "u1" } as any);
      expect(ctx.repo).toBe(repo);
      expect(ctx.data).toBeDefined();
      expect(typeof ctx.data.packages.findByName).toBe("function");
      expect(ctx.limits.maxUploadBytes).toBeGreaterThan(0);

      // The authorizer scopes the resource to the repository by default.
      ctx.authorize("read");
      expect(authorizeArgs?.[0]).toBe("read");
      expect(authorizeArgs?.[1]).toMatchObject({
        type: "repository",
        orgId: "org_1",
        repositoryId: "repo_1",
        repositoryName: "packages",
      });
    });
  });

  test("enqueueScan is a no-op when scanning is disabled", async () => {
    const realConfig = await import("@hootifactory/config");
    await mock.module("@hootifactory/config", () => ({
      ...realConfig,
      env: { ...realConfig.env, SCANNER_ENABLED: false },
    }));
    const realAuth = await import("@hootifactory/auth");
    await mock.module("@hootifactory/auth", () => ({
      ...realAuth,
      createRequestAuthorizer: () => () => ({ allowed: true }),
    }));
    await withFakeDb([[{ id: "art_1" }], []], async (calls) => {
      const { buildRegistryRequestContext } = await import("./request-context");
      const ctx = buildRegistryRequestContext(repo, { kind: "user", userId: "u1" } as any);
      await ctx.enqueueScan({ digest: DIGEST });
      // No outbox write happens while scanning is disabled.
      expect(calls.some((c) => c.op === "onConflictDoUpdate")).toBe(false);
    });
  });

  test("enqueueScan records the outbox when scanning is enabled", async () => {
    const realConfig = await import("@hootifactory/config");
    await mock.module("@hootifactory/config", () => ({
      ...realConfig,
      env: { ...realConfig.env, SCANNER_ENABLED: true },
    }));
    const realAuth = await import("@hootifactory/auth");
    await mock.module("@hootifactory/auth", () => ({
      ...realAuth,
      createRequestAuthorizer: () => () => ({ allowed: true }),
    }));
    await withFakeDb([[{ id: "art_1" }], []], async (calls) => {
      const { buildRegistryRequestContext } = await import("./request-context");
      const ctx = buildRegistryRequestContext(repo, { kind: "user", userId: "u1" } as any);
      await ctx.enqueueScan({ digest: DIGEST, name: "demo", version: "1.0.0" });
      expect(calls.some((c) => c.op === "onConflictDoUpdate")).toBe(true);
    });
  });
});
