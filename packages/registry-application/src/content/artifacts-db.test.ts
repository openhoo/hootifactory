import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTestRegistryContext } from "@hootifactory/registry/testing";

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

async function withMocks<T>(
  opts: { rowsByCall?: unknown[][]; policy?: unknown },
  run: () => Promise<T>,
): Promise<T> {
  const realDb = await import("@hootifactory/db");
  const { builder } = fakeDb(opts.rowsByCall ?? []);
  await mock.module("@hootifactory/db", () => ({ ...realDb, db: builder }));
  await mock.module("../governance/scan-policy", () => ({
    resolveRegistryScanPolicy: async () => opts.policy ?? null,
    invalidateRegistryScanPolicyCache: () => {},
  }));
  return run();
}

const ctx = () => createTestRegistryContext();

describe("areAllArtifactsBlocked", () => {
  afterEach(() => mock.restore());

  test("returns false for an empty digest set without querying", async () => {
    const result = await withMocks({}, async () => {
      const { areAllArtifactsBlocked } = await import("./artifacts");
      return areAllArtifactsBlocked(ctx(), []);
    });
    expect(result).toBe(false);
  });

  test("in audit mode, blocks only when every digest is explicitly 'blocked'", async () => {
    const allBlocked = await withMocks(
      {
        policy: { mode: "audit" },
        rowsByCall: [
          [
            { digest: "sha256:a", state: "blocked" },
            { digest: "sha256:b", state: "blocked" },
          ],
        ],
      },
      async () => {
        const { areAllArtifactsBlocked } = await import("./artifacts");
        return areAllArtifactsBlocked(ctx(), ["sha256:a", "sha256:b"]);
      },
    );
    expect(allBlocked).toBe(true);

    const oneClean = await withMocks(
      {
        policy: { mode: "audit" },
        rowsByCall: [
          [
            { digest: "sha256:a", state: "blocked" },
            { digest: "sha256:b", state: "clean" },
          ],
        ],
      },
      async () => {
        const { areAllArtifactsBlocked } = await import("./artifacts");
        return areAllArtifactsBlocked(ctx(), ["sha256:a", "sha256:b"]);
      },
    );
    expect(oneClean).toBe(false);
  });

  test("in enforce mode, fails closed unless every digest is positively 'clean'", async () => {
    // No rows at all: neither digest is clean => the whole set is blocked.
    const noneClean = await withMocks(
      { policy: { mode: "enforce" }, rowsByCall: [[]] },
      async () => {
        const { areAllArtifactsBlocked } = await import("./artifacts");
        return areAllArtifactsBlocked(ctx(), ["sha256:a", "sha256:b"]);
      },
    );
    expect(noneClean).toBe(true);

    // A single positively-clean digest is served.
    const allClean = await withMocks(
      { policy: { mode: "enforce" }, rowsByCall: [[{ digest: "sha256:a", state: "clean" }]] },
      async () => {
        const { areAllArtifactsBlocked } = await import("./artifacts");
        return areAllArtifactsBlocked(ctx(), ["sha256:a"]);
      },
    );
    expect(allClean).toBe(false);
  });
});

describe("isArtifactBlocked", () => {
  afterEach(() => mock.restore());

  test("delegates to areAllArtifactsBlocked for a single digest", async () => {
    const blocked = await withMocks(
      { policy: { mode: "audit" }, rowsByCall: [[{ digest: "sha256:a", state: "blocked" }]] },
      async () => {
        const { isArtifactBlocked } = await import("./artifacts");
        return isArtifactBlocked(ctx(), "sha256:a");
      },
    );
    expect(blocked).toBe(true);
  });
});

describe("loadContentAddressableManifestRaw", () => {
  afterEach(() => mock.restore());

  test("returns the raw manifest row or null", async () => {
    const found = await withMocks({ rowsByCall: [[{ raw: "{}" }]] }, async () => {
      const { loadContentAddressableManifestRaw } = await import("./artifacts");
      return loadContentAddressableManifestRaw({ repositoryId: "r1", digest: "sha256:d" });
    });
    expect(found).toEqual({ raw: "{}" });

    const none = await withMocks({ rowsByCall: [[]] }, async () => {
      const { loadContentAddressableManifestRaw } = await import("./artifacts");
      return loadContentAddressableManifestRaw({ repositoryId: "r1", digest: "sha256:d" });
    });
    expect(none).toBeNull();
  });
});

describe("invalidateScanPolicyCache", () => {
  afterEach(() => mock.restore());

  test("forwards the org id to the scan-policy cache", async () => {
    let invalidated: string | undefined = "untouched";
    const realDb = await import("@hootifactory/db");
    await mock.module("@hootifactory/db", () => ({ ...realDb }));
    await mock.module("../governance/scan-policy", () => ({
      resolveRegistryScanPolicy: async () => null,
      invalidateRegistryScanPolicyCache: (orgId?: string) => {
        invalidated = orgId;
      },
    }));
    const { invalidateScanPolicyCache } = await import("./artifacts");
    invalidateScanPolicyCache("org_1");
    expect(invalidated).toBe("org_1");
  });
});

describe("serveBlobIfClean cache-control", () => {
  afterEach(() => mock.restore());

  test("uses the request-context immutable cache header when the artifact is clean", async () => {
    const realStorage = await import("@hootifactory/storage");
    await mock.module("@hootifactory/storage", () => ({
      ...realStorage,
      blobStore: { get: () => "BYTES" },
    }));
    const res = await withMocks({ policy: { mode: "audit" }, rowsByCall: [[]] }, async () => {
      const { serveBlobIfClean } = await import("./artifacts");
      // No artifact rows + audit mode => not blocked, so bytes are served.
      return serveBlobIfClean(ctx(), {
        digest: "sha256:deadbeef",
        contentType: "application/octet-stream",
        blocked: () => new Response("blocked", { status: 403 }),
      });
    });
    expect(res.status).toBe(200);
    // immutableRegistryBlobCacheControl derives from the resolved ctx.
    expect(res.headers.get("cache-control")).toBeTruthy();
  });
});
