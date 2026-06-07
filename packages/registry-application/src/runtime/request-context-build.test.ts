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
        digest: "sha256:d",
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

  test("returns null when the artifact upsert yields no row", async () => {
    const result = await withFakeDb([[]], async (calls) => {
      const { recordArtifactScanOutbox } = await import("./request-context");
      const r = await recordArtifactScanOutbox(repo, { digest: "sha256:d" });
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
      await ctx.enqueueScan({ digest: "sha256:d" });
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
      await ctx.enqueueScan({ digest: "sha256:d", name: "demo", version: "1.0.0" });
      expect(calls.some((c) => c.op === "onConflictDoUpdate")).toBe(true);
    });
  });
});
