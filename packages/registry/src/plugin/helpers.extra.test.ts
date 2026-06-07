import { describe, expect, test } from "bun:test";
import { createTestRegistryContext } from "../testing";
import type { RegistryPackageHandle, RegistryPackageRow, RegistryStoredBlob } from "./data";
import {
  commitPackageVersionBlob,
  findOrCreateRegistryPackage,
  findRegistryPackage,
  ifNoneMatch,
  publishImmutableVersionBlob,
  releaseRegistryBlobRef,
  requireRegistryPackage,
  sha1hexText,
  storeAndCommitPackageVersionBlob,
  storeRegistryBlobStreamWithRef,
  storeRegistryBlobWithRef,
  textEtag,
} from "./helpers";

function makePackageRow(overrides: Partial<RegistryPackageRow> = {}): RegistryPackageRow {
  return {
    id: "pkg_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    name: "left-pad",
    namespace: null,
    metadata: {},
    latestVersion: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeStoredBlob(overrides: Partial<RegistryStoredBlob> = {}): RegistryStoredBlob {
  return {
    digest: "sha256:abc",
    size: 3,
    deduped: false,
    refCreated: true,
    blobRefId: "ref_1",
    ...overrides,
  };
}

/** Build a context whose content/packages/versions data ports are spied on. */
function contextWithData(
  content: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  const base = createTestRegistryContext();
  return createTestRegistryContext({
    data: {
      ...base.data,
      content: { ...base.data.content, ...content },
      ...extra,
    },
  });
}

describe("helpers — small pure utilities", () => {
  test("sha1hexText is a stable 40-char lowercase hex digest", () => {
    const digest = sha1hexText("hello");
    expect(digest).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    expect(digest).toBe(sha1hexText("hello"));
    expect(sha1hexText("world")).not.toBe(digest);
  });

  test("textEtag wraps the sha1 of the body in quotes", () => {
    expect(textEtag("hello")).toBe(`"${sha1hexText("hello")}"`);
  });

  test("ifNoneMatch is false without the header and true on weak/strong/star matches", () => {
    const etag = textEtag("body");
    expect(ifNoneMatch(new Request("https://x.test"), etag)).toBe(false);
    expect(
      ifNoneMatch(new Request("https://x.test", { headers: { "if-none-match": etag } }), etag),
    ).toBe(true);
    expect(
      ifNoneMatch(
        new Request("https://x.test", { headers: { "if-none-match": `W/${etag}` } }),
        etag,
      ),
    ).toBe(true);
    expect(
      ifNoneMatch(new Request("https://x.test", { headers: { "if-none-match": "*" } }), etag),
    ).toBe(true);
    expect(
      ifNoneMatch(
        new Request("https://x.test", { headers: { "if-none-match": '"other", W/"another"' } }),
        etag,
      ),
    ).toBe(false);
  });
});

describe("helpers — package lookups", () => {
  test("findRegistryPackage forwards to data.packages.findByName", async () => {
    const row = makePackageRow();
    let asked: string | undefined;
    const ctx = contextWithData(
      {},
      {
        packages: {
          ...createTestRegistryContext().data.packages,
          findByName: (name: string) => {
            asked = name;
            return Promise.resolve(row);
          },
        },
      },
    );
    await expect(findRegistryPackage(ctx, "left-pad")).resolves.toBe(row);
    expect(asked).toBe("left-pad");
  });

  test("findOrCreateRegistryPackage forwards to data.packages.findOrCreate", async () => {
    const row = makePackageRow({ namespace: "scope" });
    let received: { name: string; namespace?: string | null } | undefined;
    const ctx = contextWithData(
      {},
      {
        packages: {
          ...createTestRegistryContext().data.packages,
          findOrCreate: (input: { name: string; namespace?: string | null }) => {
            received = input;
            return Promise.resolve(row);
          },
        },
      },
    );
    await expect(
      findOrCreateRegistryPackage(ctx, { name: "pkg", namespace: "scope" }),
    ).resolves.toBe(row);
    expect(received).toEqual({ name: "pkg", namespace: "scope" });
  });

  test("requireRegistryPackage returns the row when present", async () => {
    const row = makePackageRow();
    const ctx = contextWithData(
      {},
      {
        packages: {
          ...createTestRegistryContext().data.packages,
          findByName: () => Promise.resolve(row),
        },
      },
    );
    await expect(requireRegistryPackage(ctx, "left-pad")).resolves.toBe(row);
  });

  test("requireRegistryPackage throws a 404 when absent", async () => {
    const ctx = createTestRegistryContext(); // default findByName resolves null
    await expect(requireRegistryPackage(ctx, "missing")).rejects.toMatchObject({ status: 404 });
  });
});

describe("helpers — blob storage delegation", () => {
  test("storeRegistryBlobWithRef forwards to content.storeBlobWithRef", async () => {
    const stored = makeStoredBlob();
    const input = { data: new Uint8Array([1]), scope: "s", kind: "k" } as never;
    let seen: unknown;
    const ctx = contextWithData({
      storeBlobWithRef: (value: unknown) => {
        seen = value;
        return Promise.resolve(stored);
      },
    });
    await expect(storeRegistryBlobWithRef(ctx, input)).resolves.toBe(stored);
    expect(seen).toBe(input);
  });

  test("storeRegistryBlobStreamWithRef forwards to content.storeBlobStreamWithRef", async () => {
    const stored = makeStoredBlob();
    const input = { stream: new ReadableStream(), scope: "s", kind: "k" } as never;
    const ctx = contextWithData({
      storeBlobStreamWithRef: () => Promise.resolve(stored),
    });
    await expect(storeRegistryBlobStreamWithRef(ctx, input)).resolves.toBe(stored);
  });

  test("releaseRegistryBlobRef forwards to content.releaseBlobRef", async () => {
    let released: unknown;
    const ctx = contextWithData({
      releaseBlobRef: (value: unknown) => {
        released = value;
        return Promise.resolve();
      },
    });
    await releaseRegistryBlobRef(ctx, { digest: "sha256:abc", kind: "k", scope: "s" });
    expect(released).toEqual({ digest: "sha256:abc", kind: "k", scope: "s" });
  });

  test("commitPackageVersionBlob forwards to versions.commitOrReleaseBlob", async () => {
    const pkg: RegistryPackageHandle = {
      id: "pkg_1",
      orgId: "org_1",
      repositoryId: "repo_1",
      name: "left-pad",
    };
    let seen: unknown;
    const ctx = contextWithData(
      {},
      {
        versions: {
          ...createTestRegistryContext().data.versions,
          commitOrReleaseBlob: (value: unknown) => {
            seen = value;
            return Promise.resolve({ versionId: "ver_1" });
          },
        },
      },
    );
    const input = {
      stored: makeStoredBlob(),
      kind: "k",
      scope: "s",
      package: pkg,
      version: "1.0.0",
      metadata: {},
      sizeBytes: 3,
      scan: {},
    };
    await expect(commitPackageVersionBlob(ctx, input)).resolves.toEqual({ versionId: "ver_1" });
    expect(seen).toBe(input);
  });
});

describe("helpers — storeAndCommitPackageVersionBlob", () => {
  const pkg: RegistryPackageHandle = {
    id: "pkg_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    name: "left-pad",
  };

  test("returns ok with the version id when the commit succeeds", async () => {
    const stored = makeStoredBlob();
    const ctx = contextWithData(
      { storeBlobWithRef: () => Promise.resolve(stored) },
      {
        versions: {
          ...createTestRegistryContext().data.versions,
          commitOrReleaseBlob: () => Promise.resolve({ versionId: "ver_42" }),
        },
      },
    );
    const result = await storeAndCommitPackageVersionBlob(ctx, {
      blob: { data: new Uint8Array([1]), scope: "s", kind: "k" } as never,
      kind: "k",
      scope: "s",
      package: pkg,
      version: "1.0.0",
      metadata: {},
      sizeBytes: 3,
      scan: {},
    });
    expect(result).toEqual({ ok: true, stored, versionId: "ver_42" });
  });

  test("returns conflict when the commit reports a conflict", async () => {
    const stored = makeStoredBlob();
    const ctx = contextWithData(
      { storeBlobWithRef: () => Promise.resolve(stored) },
      {
        versions: {
          ...createTestRegistryContext().data.versions,
          commitOrReleaseBlob: () => Promise.resolve({ conflict: true as const }),
        },
      },
    );
    const result = await storeAndCommitPackageVersionBlob(ctx, {
      blob: { data: new Uint8Array([1]), scope: "s", kind: "k" } as never,
      kind: "k",
      scope: "s",
      package: pkg,
      version: "1.0.0",
      metadata: {},
      sizeBytes: 3,
      scan: {},
    });
    expect(result).toEqual({ ok: false, stored, conflict: true });
  });
});

describe("helpers — publishImmutableVersionBlob", () => {
  const built: Record<string, unknown> = {};

  function publishContext(commitResult: { versionId: string } | { conflict: true }) {
    const stored = makeStoredBlob();
    const pkg = makePackageRow();
    return {
      stored,
      pkg,
      ctx: contextWithData(
        { storeBlobWithRef: () => Promise.resolve(stored) },
        {
          packages: {
            ...createTestRegistryContext().data.packages,
            findOrCreate: () => Promise.resolve(pkg),
          },
          versions: {
            ...createTestRegistryContext().data.versions,
            commitOrReleaseBlob: (value: { metadata: unknown; asset?: unknown }) => {
              built.metadata = value.metadata;
              built.asset = value.asset;
              return Promise.resolve(commitResult);
            },
          },
        },
      ),
    };
  }

  test("publishes immutably and reports the resulting version", async () => {
    const { ctx, pkg, stored } = publishContext({ versionId: "ver_7" });
    const result = await publishImmutableVersionBlob(ctx, {
      package: { name: "left-pad" },
      version: "1.0.0",
      blob: { data: new Uint8Array([1]), scope: "s", kind: "k" } as never,
      kind: "k",
      scope: "s",
      metadata: (s) => ({ digest: s.digest }),
      sizeBytes: 3,
      scan: {},
      asset: (s) => ({ role: "main", digest: s.digest }) as never,
    });
    expect(result).toEqual({ ok: true, pkg, stored, versionId: "ver_7" });
    // metadata()/asset() callbacks received the stored blob.
    expect(built.metadata).toEqual({ digest: stored.digest });
    expect(built.asset).toEqual({ role: "main", digest: stored.digest });
  });

  test("short-circuits with a conflict when versionConflict resolves true", async () => {
    const { ctx, pkg } = publishContext({ versionId: "never" });
    let stored = false;
    const ctx2 = createTestRegistryContext({
      data: {
        ...ctx.data,
        content: {
          ...ctx.data.content,
          storeBlobWithRef: () => {
            stored = true;
            return Promise.resolve(makeStoredBlob());
          },
        },
      },
    });
    const result = await publishImmutableVersionBlob(ctx2, {
      package: { name: "left-pad" },
      version: "1.0.0",
      blob: { data: new Uint8Array([1]), scope: "s", kind: "k" } as never,
      kind: "k",
      scope: "s",
      metadata: () => ({}),
      sizeBytes: 3,
      scan: {},
      versionConflict: () => Promise.resolve(true),
    });
    expect(result).toEqual({ ok: false, pkg, conflict: true });
    // The blob must not be stored when the version already exists.
    expect(stored).toBe(false);
  });

  test("reports a conflict raised by the commit step", async () => {
    const { ctx, pkg } = publishContext({ conflict: true });
    const result = await publishImmutableVersionBlob(ctx, {
      package: { name: "left-pad" },
      version: "1.0.0",
      blob: { data: new Uint8Array([1]), scope: "s", kind: "k" } as never,
      kind: "k",
      scope: "s",
      metadata: () => ({}),
      sizeBytes: 3,
      scan: {},
      versionConflict: () => Promise.resolve(false),
    });
    expect(result).toEqual({ ok: false, pkg, conflict: true });
  });
});
