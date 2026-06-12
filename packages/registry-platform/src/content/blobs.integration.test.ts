import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  and,
  blobRefs,
  blobs,
  count,
  db,
  eq,
  inArray,
  isNull,
  organizations,
  quotas,
  repositories,
} from "@hootifactory/db";
import type { RegistryRequestContext } from "@hootifactory/registry";
import { computeDigest } from "@hootifactory/registry";
import { createTestRegistryContext, createTestResolvedRepo } from "@hootifactory/registry/testing";
import { blobStore } from "@hootifactory/storage";
import { releaseBlobRef, storeBlobWithRef, sweepUnreferencedCasBlobs } from "./blobs";

// DB+MinIO-backed coverage for the CAS refcount/quota/GC contract, which is split
// between app code (increment, quota charge/refund) and a SQL trigger (decrement +
// state transition). The only end-to-end coverage lives in Docker-gated e2e that
// cannot run in CI, so these invariants were otherwise untested.

let orgId = "";
let secondOrgId = "";
let repoA = "";
let repoB = "";
let repoC = "";
const createdDigests = new Set<string>();

function ctxFor(repoId: string, org: string): RegistryRequestContext {
  return createTestRegistryContext({ repo: createTestResolvedRepo({ id: repoId, orgId: org }) });
}

function randomBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(48));
}

async function refState(digest: string) {
  const [row] = await db
    .select({ refCount: blobs.refCount, state: blobs.state, pendingSince: blobs.pendingSince })
    .from(blobs)
    .where(eq(blobs.digest, digest))
    .limit(1);
  return row ?? null;
}

async function blobRefRows(digest: string): Promise<number> {
  const [row] = await db.select({ c: count() }).from(blobRefs).where(eq(blobRefs.digest, digest));
  return row?.c ?? 0;
}

async function usedStorage(org: string): Promise<number> {
  const [row] = await db
    .select({ used: quotas.usedStorageBytes })
    .from(quotas)
    .where(and(eq(quotas.orgId, org), isNull(quotas.repositoryId)))
    .limit(1);
  return row?.used ?? 0;
}

async function seedRepo(org: string, name: string): Promise<string> {
  const [repo] = await db
    .insert(repositories)
    .values({
      orgId: org,
      name,
      moduleId: "test",
      mountPath: `${org}/${name}`,
      storagePrefix: `${org}/${name}`,
    })
    .returning({ id: repositories.id });
  return repo!.id;
}

beforeAll(async () => {
  const [org] = await db
    .insert(organizations)
    .values({ slug: `blobtest-${crypto.randomUUID().slice(0, 8)}`, displayName: "Blob Test Org" })
    .returning();
  orgId = org!.id;
  const [org2] = await db
    .insert(organizations)
    .values({ slug: `blobtest-${crypto.randomUUID().slice(0, 8)}`, displayName: "Blob Test Org 2" })
    .returning();
  secondOrgId = org2!.id;
  // adjustStorageUsedTx UPDATEs the org-level quota row, so it must exist to track usage.
  await db.insert(quotas).values({ orgId, maxStorageBytes: null, usedStorageBytes: 0 });
  await db
    .insert(quotas)
    .values({ orgId: secondOrgId, maxStorageBytes: null, usedStorageBytes: 0 });
  repoA = await seedRepo(orgId, "repo-a");
  repoB = await seedRepo(orgId, "repo-b");
  repoC = await seedRepo(secondOrgId, "repo-c");
});

afterAll(async () => {
  // Deleting orgs cascades repos -> blob_refs (firing the decrement trigger) and quotas.
  if (secondOrgId) await db.delete(organizations).where(eq(organizations.id, secondOrgId));
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  // blobs are global (no FK to org); remove the rows + objects this suite created.
  const digests = [...createdDigests];
  if (digests.length) {
    await db.delete(blobs).where(inArray(blobs.digest, digests));
    for (const digest of digests) await blobStore.delete(digest).catch(() => {});
  }
});

describe("blobs CAS refcount/quota/GC (DB + MinIO)", () => {
  test("ref_count tracks blob_refs and the last release reclaims the blob", async () => {
    const ctx = ctxFor(repoA, orgId);
    const data = randomBytes();
    const stored = await storeBlobWithRef(ctx, { data, kind: "layer", scope: "s1" });
    const digest = stored.digest;
    createdDigests.add(digest);
    // A second ref for the same digest in the same repo (distinct scope).
    await storeBlobWithRef(ctx, { data, kind: "layer", scope: "s2" });

    expect(await refState(digest)).toMatchObject({ refCount: 2, state: "active" });
    expect(await blobRefRows(digest)).toBe(2);

    await releaseBlobRef(ctx, { digest, kind: "layer", scope: "s1" });
    expect(await refState(digest)).toMatchObject({ refCount: 1, state: "active" });
    expect(await blobRefRows(digest)).toBe(1);

    // Releasing the last ref drops ref_count to 0 and leaves the blob pending
    // during the configured grace period.
    await releaseBlobRef(ctx, { digest, kind: "layer", scope: "s2" });
    expect(await refState(digest)).toMatchObject({ refCount: 0, state: "pending_delete" });
    expect(await blobRefRows(digest)).toBe(0);
    expect(await blobStore.stat(digest)).not.toBeNull();

    await sweepUnreferencedCasBlobs({ limit: 50, graceMs: 0 });
    expect(await refState(digest)).toBeNull();
    expect(await blobStore.stat(digest)).toBeNull();
  });

  test("org storage quota is charged once per digest and refunded once", async () => {
    const data = randomBytes();
    const size = data.byteLength;
    const before = await usedStorage(orgId);

    const stored = await storeBlobWithRef(ctxFor(repoA, orgId), {
      data,
      kind: "layer",
      scope: "x",
    });
    createdDigests.add(stored.digest);
    // Same digest, second repo, SAME org -> charged once total.
    await storeBlobWithRef(ctxFor(repoB, orgId), { data, kind: "layer", scope: "x" });
    expect(await usedStorage(orgId)).toBe(before + size);

    // Same digest in a different org -> charged independently.
    const beforeSecond = await usedStorage(secondOrgId);
    await storeBlobWithRef(ctxFor(repoC, secondOrgId), { data, kind: "layer", scope: "x" });
    expect(await usedStorage(secondOrgId)).toBe(beforeSecond + size);

    // Release one of the two same-org refs -> org still references it -> unchanged.
    await releaseBlobRef(ctxFor(repoA, orgId), {
      digest: stored.digest,
      kind: "layer",
      scope: "x",
    });
    expect(await usedStorage(orgId)).toBe(before + size);

    // Release the last same-org ref -> refunded back to baseline.
    await releaseBlobRef(ctxFor(repoB, orgId), {
      digest: stored.digest,
      kind: "layer",
      scope: "x",
    });
    expect(await usedStorage(orgId)).toBe(before);
  });

  test("cascade-deleted refs leave the blob pending_delete for the grace-gated sweep", async () => {
    // A repo (or org) delete cascades blob_refs and fires the decrement trigger,
    // but — unlike releaseBlobRef — does NOT synchronously reclaim the CAS blob, so
    // the blob is left pending_delete and the grace-gated sweep is what reclaims it.
    const tmpRepo = await seedRepo(orgId, `tmp-${crypto.randomUUID().slice(0, 8)}`);
    const data = randomBytes();
    const stored = await storeBlobWithRef(ctxFor(tmpRepo, orgId), {
      data,
      kind: "layer",
      scope: "c",
    });
    const digest = stored.digest;
    createdDigests.add(digest);
    expect(await refState(digest)).toMatchObject({ refCount: 1, state: "active" });

    await db.delete(repositories).where(eq(repositories.id, tmpRepo));
    const afterDelete = await refState(digest);
    expect(afterDelete?.refCount).toBe(0);
    expect(afterDelete?.state).toBe("pending_delete");
    expect(afterDelete?.pendingSince).not.toBeNull();
    expect(await blobRefRows(digest)).toBe(0);

    // Within the grace window: not eligible, so it survives.
    await sweepUnreferencedCasBlobs({ limit: 50, graceMs: 60_000 });
    expect(await refState(digest)).not.toBeNull();
    expect(await blobStore.stat(digest)).not.toBeNull();

    // Age it past the grace window: now reclaimed (row + S3 object gone).
    await db
      .update(blobs)
      .set({ pendingSince: new Date(Date.now() - 120_000) })
      .where(eq(blobs.digest, digest));
    await sweepUnreferencedCasBlobs({ limit: 50, graceMs: 60_000 });
    expect(await refState(digest)).toBeNull();
    expect(await blobStore.stat(digest)).toBeNull();
  });

  test("a failed transaction discards the pre-staged CAS object (no leak)", async () => {
    // The S3 put now happens BEFORE the transaction. Point the context at a
    // repository id that does not exist so the blob_refs INSERT violates its FK
    // and the whole tx rolls back AFTER the object was staged: the compensation
    // path must delete the staged object and leave no blobs row or quota charge.
    const ctx = ctxFor(crypto.randomUUID(), orgId);
    const data = randomBytes();
    const digest = computeDigest(data);
    createdDigests.add(digest);
    const before = await usedStorage(orgId);

    await expect(storeBlobWithRef(ctx, { data, kind: "layer", scope: "boom" })).rejects.toThrow();

    expect(await refState(digest)).toBeNull();
    expect(await blobRefRows(digest)).toBe(0);
    expect(await blobStore.stat(digest)).toBeNull();
    expect(await usedStorage(orgId)).toBe(before);
  });

  test("sweep never reclaims a blob reactivated after going pending_delete", async () => {
    const tmpRepo = await seedRepo(orgId, `tmp2-${crypto.randomUUID().slice(0, 8)}`);
    const data = randomBytes();
    const stored = await storeBlobWithRef(ctxFor(tmpRepo, orgId), {
      data,
      kind: "layer",
      scope: "r",
    });
    const digest = stored.digest;
    createdDigests.add(digest);
    await db.delete(repositories).where(eq(repositories.id, tmpRepo));
    expect(await refState(digest)).toMatchObject({ refCount: 0, state: "pending_delete" });

    // Simulate a concurrent re-mount reactivating the blob past the grace window.
    await db
      .update(blobs)
      .set({ state: "active", pendingSince: null, refCount: 1 })
      .where(eq(blobs.digest, digest));
    await sweepUnreferencedCasBlobs({ limit: 50, graceMs: 60_000 });
    expect(await refState(digest)).not.toBeNull();
    expect(await blobStore.stat(digest)).not.toBeNull();
  });
});
