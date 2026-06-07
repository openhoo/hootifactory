import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTestRegistryContext } from "@hootifactory/registry/testing";

/**
 * Chainable, awaitable drizzle stub. Builder methods record + return the chain;
 * awaiting resolves to the next configured row batch in call order. Doubles as
 * the transaction handle.
 */
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
      if (prop === "execute") {
        return async () => [];
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
  // lockDigestTx is imported from ./blobs and only calls tx.execute(sql) — the
  // stubbed tx.execute is a no-op, so no extra mock is needed.
  return run(calls);
}

const ctx = () => createTestRegistryContext();

describe("listExistingContentBlobRefDigests", () => {
  afterEach(() => mock.restore());

  test("returns [] without a query for an empty digest list", async () => {
    const result = await withFakeDb([[]], async (calls) => {
      const { listExistingContentBlobRefDigests } = await import("./manifest-store");
      const r = await listExistingContentBlobRefDigests(ctx(), { scope: "s", digests: [] });
      expect(calls.map((c) => c.op)).not.toContain("select");
      return r;
    });
    expect(result).toEqual([]);
  });

  test("maps the matched rows to digests", async () => {
    const result = await withFakeDb(
      [[{ digest: "sha256:a" }, { digest: "sha256:b" }]],
      async () => {
        const { listExistingContentBlobRefDigests } = await import("./manifest-store");
        return listExistingContentBlobRefDigests(ctx(), { scope: "s", digests: ["sha256:a"] });
      },
    );
    expect(result).toEqual(["sha256:a", "sha256:b"]);
  });
});

describe("listExistingContentManifestDigests", () => {
  afterEach(() => mock.restore());

  test("returns [] for an empty digest list", async () => {
    const result = await withFakeDb([[]], async () => {
      const { listExistingContentManifestDigests } = await import("./manifest-store");
      return listExistingContentManifestDigests(ctx(), { packageId: "p1", digests: [] });
    });
    expect(result).toEqual([]);
  });

  test("unions the tagged + version-pinned digest reads and dedups", async () => {
    // Two concurrent reads: tagged rows then version rows.
    const result = await withFakeDb(
      [[{ digest: "sha256:a" }], [{ digest: "sha256:a" }, { digest: "sha256:c" }]],
      async () => {
        const { listExistingContentManifestDigests } = await import("./manifest-store");
        return listExistingContentManifestDigests(ctx(), {
          packageId: "p1",
          digests: ["sha256:a", "sha256:c"],
        });
      },
    );
    expect(result.sort()).toEqual(["sha256:a", "sha256:c"]);
  });
});

describe("contentBlobRefExists", () => {
  afterEach(() => mock.restore());

  test("reflects whether the ref row exists", async () => {
    await withFakeDb([[{ id: "ref" }]], async () => {
      const { contentBlobRefExists } = await import("./manifest-store");
      expect(await contentBlobRefExists(ctx(), { scope: "s", digest: "sha256:a" })).toBe(true);
    });
    await withFakeDb([[]], async () => {
      const { contentBlobRefExists } = await import("./manifest-store");
      expect(await contentBlobRefExists(ctx(), { scope: "s", digest: "sha256:a" })).toBe(false);
    });
  });
});

describe("replaceContentManifestBlobRefs", () => {
  afterEach(() => mock.restore());

  test("deletes existing refs then inserts the new digests", async () => {
    await withFakeDb([[]], async (calls) => {
      const { replaceContentManifestBlobRefs } = await import("./manifest-store");
      await replaceContentManifestBlobRefs(ctx(), {
        packageId: "p1",
        manifestId: "m1",
        digests: ["sha256:a", "sha256:a", "sha256:b"],
      });
      expect(calls.map((c) => c.op)).toContain("delete");
      expect(calls.map((c) => c.op)).toContain("insert");
    });
  });

  test("skips the insert when there are no digests", async () => {
    await withFakeDb([[]], async (calls) => {
      const { replaceContentManifestBlobRefs } = await import("./manifest-store");
      await replaceContentManifestBlobRefs(ctx(), {
        packageId: "p1",
        manifestId: "m1",
        digests: [],
      });
      expect(calls.map((c) => c.op)).toContain("delete");
      expect(calls.map((c) => c.op)).not.toContain("insert");
    });
  });
});

describe("commitContentManifest", () => {
  afterEach(() => mock.restore());

  test("upserts the manifest and re-points each tag", async () => {
    // tx select-lock is via execute (no row); manifest upsert returns a row; tag upserts resolve.
    const result = await withFakeDb(
      [[{ id: "m1", repositoryId: "r1", digest: "sha256:d" }]],
      async (calls) => {
        const { commitContentManifest } = await import("./manifest-store");
        const r = await commitContentManifest(ctx(), {
          manifest: {
            digest: "sha256:d",
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            artifactType: null,
            subjectDigest: null,
            raw: "{}",
            sizeBytes: 2,
            configDigest: null,
          },
          packageId: "p1",
          tags: ["latest", "v1"],
        });
        expect(calls.map((c) => c.op)).toContain("onConflictDoUpdate");
        return r;
      },
    );
    expect(result).toEqual({ id: "m1", repositoryId: "r1", digest: "sha256:d" });
  });

  test("throws when the manifest upsert returns no row", async () => {
    await withFakeDb([[]], async () => {
      const { commitContentManifest } = await import("./manifest-store");
      await expect(
        commitContentManifest(ctx(), {
          manifest: {
            digest: "sha256:d",
            mediaType: "m",
            artifactType: null,
            subjectDigest: null,
            raw: "{}",
            sizeBytes: 2,
            configDigest: null,
          },
          packageId: "p1",
          tags: [],
        }),
      ).rejects.toThrow("failed to upsert content manifest");
    });
  });
});

describe("resolveContentManifest", () => {
  afterEach(() => mock.restore());

  test("resolves a tag reference via the tag join", async () => {
    const result = await withFakeDb(
      [[{ manifest: { id: "m1", digest: "sha256:d" } }]],
      async () => {
        const { resolveContentManifest } = await import("./manifest-store");
        return resolveContentManifest(ctx(), { packageId: "p1", reference: "latest" });
      },
    );
    expect(result).toEqual({ id: "m1", digest: "sha256:d" });
  });

  test("resolves a digest reference, preferring the tagged manifest", async () => {
    const result = await withFakeDb([[{ manifest: { id: "m1" } }]], async () => {
      const { resolveContentManifest } = await import("./manifest-store");
      return resolveContentManifest(ctx(), {
        packageId: "p1",
        reference: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
    });
    expect(result).toEqual({ id: "m1" });
  });

  test("resolves a digest reference via a pinned version when not tagged", async () => {
    // tagged read empty -> version exists -> manifest row.
    const result = await withFakeDb(
      [[], [{ id: "v1" }], [{ id: "m2", digest: "sha256:d" }]],
      async () => {
        const { resolveContentManifest } = await import("./manifest-store");
        return resolveContentManifest(ctx(), {
          packageId: "p1",
          reference: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        });
      },
    );
    expect(result).toEqual({ id: "m2", digest: "sha256:d" });
  });

  test("returns null for an unknown digest with no version", async () => {
    const result = await withFakeDb([[], []], async () => {
      const { resolveContentManifest } = await import("./manifest-store");
      return resolveContentManifest(ctx(), {
        packageId: "p1",
        reference: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      });
    });
    expect(result).toBeNull();
  });
});

describe("tag + version deletion helpers", () => {
  afterEach(() => mock.restore());

  test("deleteContentTagsForManifest issues a scoped delete", async () => {
    await withFakeDb([[]], async (calls) => {
      const { deleteContentTagsForManifest } = await import("./manifest-store");
      await deleteContentTagsForManifest({ packageId: "p1", manifestId: "m1" });
      expect(calls.map((c) => c.op)).toContain("delete");
    });
  });

  test("deleteContentTag reports whether a row was removed", async () => {
    await withFakeDb([[{ id: "t1" }]], async () => {
      const { deleteContentTag } = await import("./manifest-store");
      expect(await deleteContentTag({ packageId: "p1", tag: "latest" })).toBe(true);
    });
    await withFakeDb([[]], async () => {
      const { deleteContentTag } = await import("./manifest-store");
      expect(await deleteContentTag({ packageId: "p1", tag: "ghost" })).toBe(false);
    });
  });

  test("markContentPackageVersionsDeletedByDigest returns the pruned count and adjusts usage", async () => {
    const count = await withFakeDb([[{ id: "v1" }, { id: "v2" }]], async (calls) => {
      const { markContentPackageVersionsDeletedByDigest } = await import("./manifest-store");
      const c = await markContentPackageVersionsDeletedByDigest({
        orgId: "org_1",
        packageId: "p1",
        digest: "sha256:d",
      });
      // The usage decrement (update) only runs when rows were deleted.
      expect(calls.map((c) => c.op)).toContain("update");
      return c;
    });
    expect(count).toBe(2);
  });

  test("markContentPackageVersionsDeletedByDigest returns 0 and skips usage when nothing matched", async () => {
    const count = await withFakeDb([[]], async () => {
      const { markContentPackageVersionsDeletedByDigest } = await import("./manifest-store");
      return markContentPackageVersionsDeletedByDigest({
        orgId: "org_1",
        packageId: "p1",
        digest: "sha256:d",
      });
    });
    expect(count).toBe(0);
  });
});

describe("deleteContentManifestIfUnassociated", () => {
  afterEach(() => mock.restore());

  test("keeps a manifest that still has a live tag association", async () => {
    // hasLiveAssociations: tag found.
    const result = await withFakeDb([[{ id: "t1" }]], async (calls) => {
      const { deleteContentManifestIfUnassociated } = await import("./manifest-store");
      const r = await deleteContentManifestIfUnassociated(ctx(), {
        manifestId: "m1",
        digest: "sha256:d",
      });
      expect(calls.map((c) => c.op)).not.toContain("delete");
      return r;
    });
    expect(result).toBe(false);
  });

  test("deletes an unassociated manifest", async () => {
    // no tag, no version, then delete returns a row.
    const result = await withFakeDb([[], [], [{ id: "m1" }]], async (calls) => {
      const { deleteContentManifestIfUnassociated } = await import("./manifest-store");
      const r = await deleteContentManifestIfUnassociated(ctx(), {
        manifestId: "m1",
        digest: "sha256:d",
      });
      expect(calls.map((c) => c.op)).toContain("delete");
      return r;
    });
    expect(result).toBe(true);
  });
});

describe("listLiveContentManifestsForPackage", () => {
  afterEach(() => mock.restore());

  test("collects tagged + metadata digests and reads their manifests", async () => {
    // tag rows, version metadata rows, final manifest rows.
    const rows = await withFakeDb(
      [
        [{ digest: "sha256:a" }],
        [{ metadata: { digest: "sha256:b" } }, { metadata: {} }],
        [
          { digest: "sha256:a", raw: "{}" },
          { digest: "sha256:b", raw: "{}" },
        ],
      ],
      async () => {
        const { listLiveContentManifestsForPackage } = await import("./manifest-store");
        return listLiveContentManifestsForPackage(ctx(), "p1");
      },
    );
    expect(rows).toHaveLength(2);
  });

  test("returns [] when no digests are referenced", async () => {
    const rows = await withFakeDb([[], []], async () => {
      const { listLiveContentManifestsForPackage } = await import("./manifest-store");
      return listLiveContentManifestsForPackage(ctx(), "p1");
    });
    expect(rows).toEqual([]);
  });
});

describe("listContentTags", () => {
  afterEach(() => mock.restore());

  test("returns all tags unpaged", async () => {
    const page = await withFakeDb([[{ tag: "a" }, { tag: "b" }]], async () => {
      const { listContentTags } = await import("./manifest-store");
      return listContentTags("p1");
    });
    expect(page).toEqual({ tags: ["a", "b"], truncated: false });
  });

  test("marks the page as truncated when more rows than pageSize are returned", async () => {
    const page = await withFakeDb([[{ tag: "a" }, { tag: "b" }, { tag: "c" }]], async () => {
      const { listContentTags } = await import("./manifest-store");
      return listContentTags("p1", { pageSize: 2, last: "0" });
    });
    expect(page).toEqual({ tags: ["a", "b"], truncated: true });
  });
});

describe("listContentSubjectManifests + listContentManifestDigestsReferencingBlob", () => {
  afterEach(() => mock.restore());

  test("listContentSubjectManifests returns the referrer rows", async () => {
    const rows = await withFakeDb([[{ id: "m1" }]], async () => {
      const { listContentSubjectManifests } = await import("./manifest-store");
      return listContentSubjectManifests(ctx(), "sha256:subject");
    });
    expect(rows).toEqual([{ id: "m1" }]);
  });

  test("listContentManifestDigestsReferencingBlob unions tagged + version reads", async () => {
    const rows = await withFakeDb(
      [[{ digest: "sha256:m1" }], [{ digest: "sha256:m1" }]],
      async () => {
        const { listContentManifestDigestsReferencingBlob } = await import("./manifest-store");
        return listContentManifestDigestsReferencingBlob(ctx(), {
          packageId: "p1",
          digest: "sha256:blob",
        });
      },
    );
    expect(rows).toEqual(["sha256:m1"]);
  });
});
