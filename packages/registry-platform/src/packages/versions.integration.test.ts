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
  packages,
  packageVersions,
  quotas,
  repositories,
} from "@hootifactory/db";
import { computeDigest, type RegistryRequestContext } from "@hootifactory/registry";
import { createTestRegistryContext, createTestResolvedRepo } from "@hootifactory/registry/testing";
import { blobStore } from "@hootifactory/storage";
import { upsertPackageVersionWithBlobRef } from "./versions";

// DB+MinIO-backed coverage for the publish path that pairs a package-version
// upsert with a CAS blob ref in one transaction. Issue #313 moved the S3 put
// OUTSIDE that transaction, so these tests pin the invariants that move must
// preserve: the version/ref/quota writes stay atomic, and a tx abort discards
// the pre-staged CAS object instead of leaking it.

let orgId = "";
let repoId = "";
let packageId = "";
const createdDigests = new Set<string>();

function ctxFor(repo: string, org: string): RegistryRequestContext {
  return createTestRegistryContext({ repo: createTestResolvedRepo({ id: repo, orgId: org }) });
}

function randomBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(48));
}

async function usedStorage(org: string): Promise<number> {
  const [row] = await db
    .select({ used: quotas.usedStorageBytes })
    .from(quotas)
    .where(and(eq(quotas.orgId, org), isNull(quotas.repositoryId)))
    .limit(1);
  return row?.used ?? 0;
}

async function versionRows(pkg: string): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, pkg));
  return row?.c ?? 0;
}

async function blobRefRows(digest: string): Promise<number> {
  const [row] = await db.select({ c: count() }).from(blobRefs).where(eq(blobRefs.digest, digest));
  return row?.c ?? 0;
}

async function blobRow(digest: string) {
  const [row] = await db
    .select({ refCount: blobs.refCount, state: blobs.state })
    .from(blobs)
    .where(eq(blobs.digest, digest))
    .limit(1);
  return row ?? null;
}

beforeAll(async () => {
  const [org] = await db
    .insert(organizations)
    .values({ slug: `vertest-${crypto.randomUUID().slice(0, 8)}`, displayName: "Version Test Org" })
    .returning();
  orgId = org!.id;
  await db.insert(quotas).values({ orgId, maxStorageBytes: null, usedStorageBytes: 0 });
  const [repo] = await db
    .insert(repositories)
    .values({
      orgId,
      name: "ver-repo",
      moduleId: "test",
      mountPath: `${orgId}/ver-repo`,
      storagePrefix: `${orgId}/ver-repo`,
    })
    .returning({ id: repositories.id });
  repoId = repo!.id;
  const [pkg] = await db
    .insert(packages)
    .values({ orgId, repositoryId: repoId, name: "demo" })
    .returning({ id: packages.id });
  packageId = pkg!.id;
});

afterAll(async () => {
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  const digests = [...createdDigests];
  if (digests.length) {
    await db.delete(blobs).where(inArray(blobs.digest, digests));
    for (const digest of digests) await blobStore.delete(digest).catch(() => {});
  }
});

describe("upsertPackageVersionWithBlobRef (DB + MinIO)", () => {
  test("commits version, blob ref, and quota charge together", async () => {
    const ctx = ctxFor(repoId, orgId);
    const data = randomBytes();
    const before = await usedStorage(orgId);

    const { stored, versionId } = await upsertPackageVersionWithBlobRef(ctx, {
      packageId,
      version: "1.0.0",
      metadata: { ok: true },
      sizeBytes: data.byteLength,
      blob: { data, kind: "npm_tarball", scope: "demo@1.0.0" },
    });
    createdDigests.add(stored.digest);

    expect(stored.refCreated).toBe(true);
    expect(versionId).toBeTruthy();
    expect(await blobRow(stored.digest)).toMatchObject({ refCount: 1, state: "active" });
    expect(await blobRefRows(stored.digest)).toBe(1);
    expect(await blobStore.stat(stored.digest)).not.toBeNull();
    expect(await usedStorage(orgId)).toBe(before + data.byteLength);
  });

  test("re-publish with previousDigest swaps the blob and reclaims the old one", async () => {
    const ctx = ctxFor(repoId, orgId);
    const oldData = randomBytes();
    const newData = randomBytes();
    const before = await usedStorage(orgId);

    const first = await upsertPackageVersionWithBlobRef(ctx, {
      packageId,
      version: "2.0.0",
      metadata: {},
      sizeBytes: oldData.byteLength,
      blob: { data: oldData, kind: "npm_tarball", scope: "demo@2.0.0" },
    });
    createdDigests.add(first.stored.digest);

    const second = await upsertPackageVersionWithBlobRef(ctx, {
      packageId,
      version: "2.0.0",
      metadata: {},
      sizeBytes: newData.byteLength,
      blob: {
        data: newData,
        kind: "npm_tarball",
        scope: "demo@2.0.0",
        previousDigest: first.stored.digest,
      },
    });
    createdDigests.add(second.stored.digest);

    // Same (packageId, version) row was updated, not duplicated.
    expect(second.versionId).toBe(first.versionId);
    // The old blob lost its last ref and was reclaimed post-commit (row + object).
    expect(await blobRefRows(first.stored.digest)).toBe(0);
    expect(await blobRow(first.stored.digest)).toBeNull();
    expect(await blobStore.stat(first.stored.digest)).toBeNull();
    // The new blob is live and the org is charged for exactly the new bytes.
    expect(await blobRow(second.stored.digest)).toMatchObject({ refCount: 1, state: "active" });
    expect(await usedStorage(orgId)).toBe(before + newData.byteLength);
  });

  test("a failed transaction keeps the upsert atomic and discards the staged blob", async () => {
    // A nonexistent packageId makes the package_versions INSERT violate its FK
    // AFTER the blob row + ref were written in-tx: everything must roll back and
    // the pre-staged CAS object must be discarded (no orphaned S3 bytes).
    const ctx = ctxFor(repoId, orgId);
    const data = randomBytes();
    const digest = computeDigest(data);
    createdDigests.add(digest);
    const missingPackageId = crypto.randomUUID();
    const before = await usedStorage(orgId);

    await expect(
      upsertPackageVersionWithBlobRef(ctx, {
        packageId: missingPackageId,
        version: "1.0.0",
        metadata: {},
        sizeBytes: data.byteLength,
        blob: { data, kind: "npm_tarball", scope: "ghost@1.0.0" },
      }),
    ).rejects.toThrow();

    expect(await versionRows(missingPackageId)).toBe(0);
    expect(await blobRefRows(digest)).toBe(0);
    expect(await blobRow(digest)).toBeNull();
    expect(await blobStore.stat(digest)).toBeNull();
    expect(await usedStorage(orgId)).toBe(before);
  });
});
