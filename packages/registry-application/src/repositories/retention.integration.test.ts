import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  and,
  blobRefs,
  blobs,
  db,
  eq,
  inArray,
  isNull,
  organizations,
  packages,
  packageVersions,
  quotas,
  registryAssets,
  repositories,
} from "@hootifactory/db";
import { computeDigest, type RegistryRequestContext } from "@hootifactory/registry";
import { createTestRegistryContext, createTestResolvedRepo } from "@hootifactory/registry/testing";
import { blobStore } from "@hootifactory/storage";
import { storeBlobWithRef } from "../content/blobs";
import { applyRetention } from "./retention";

// DB+MinIO-backed coverage for applyRetention's CAS/quota reclamation. The only
// e2e is Docker-gated and asserts version-count pruning, not storage-byte
// reclamation or the shared-digest keep-set — a regression there would release a
// blob a surviving version still needs (data loss) or drift quota.

let orgId = "";
let repo = "";
let repo2 = "";
const createdDigests = new Set<string>();

function ctxFor(repoId: string): RegistryRequestContext {
  return createTestRegistryContext({ repo: createTestResolvedRepo({ id: repoId, orgId }) });
}

function randomBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(48));
}

async function seedRepo(name: string): Promise<string> {
  const [r] = await db
    .insert(repositories)
    .values({
      orgId,
      name,
      moduleId: "test",
      mountPath: `${orgId}/${name}`,
      storagePrefix: `${orgId}/${name}`,
    })
    .returning({ id: repositories.id });
  return r!.id;
}

async function seedPackage(repoId: string, name: string): Promise<string> {
  const [p] = await db
    .insert(packages)
    .values({ orgId, repositoryId: repoId, name })
    .returning({ id: packages.id });
  return p!.id;
}

async function seedVersion(packageId: string, version: string, createdAt: Date): Promise<string> {
  const [v] = await db
    .insert(packageVersions)
    .values({ orgId, packageId, version, createdAt })
    .returning({ id: packageVersions.id });
  return v!.id;
}

async function seedAsset(
  repoId: string,
  opts: {
    packageId: string;
    packageVersionId: string;
    digest: string;
    scope: string;
    size: number;
  },
): Promise<void> {
  await db.insert(registryAssets).values({
    orgId,
    repositoryId: repoId,
    packageId: opts.packageId,
    packageVersionId: opts.packageVersionId,
    digest: opts.digest,
    role: "layer",
    scope: opts.scope,
    sizeBytes: opts.size,
  });
}

async function setUsedArtifacts(n: number): Promise<void> {
  await db
    .update(quotas)
    .set({ usedArtifacts: n })
    .where(and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId)));
}

async function usedStorage(): Promise<number> {
  const [row] = await db
    .select({ used: quotas.usedStorageBytes })
    .from(quotas)
    .where(and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId)))
    .limit(1);
  return row?.used ?? 0;
}

async function usedArtifacts(): Promise<number> {
  const [row] = await db
    .select({ used: quotas.usedArtifacts })
    .from(quotas)
    .where(and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId)))
    .limit(1);
  return row?.used ?? 0;
}

async function repoRefExists(repoId: string, digest: string): Promise<boolean> {
  const [row] = await db
    .select({ id: blobRefs.id })
    .from(blobRefs)
    .where(and(eq(blobRefs.repositoryId, repoId), eq(blobRefs.digest, digest)))
    .limit(1);
  return Boolean(row);
}

async function blobExists(digest: string): Promise<boolean> {
  const [row] = await db
    .select({ digest: blobs.digest })
    .from(blobs)
    .where(eq(blobs.digest, digest))
    .limit(1);
  return Boolean(row);
}

async function versionDeleted(id: string): Promise<boolean> {
  const [row] = await db
    .select({ deletedAt: packageVersions.deletedAt })
    .from(packageVersions)
    .where(eq(packageVersions.id, id))
    .limit(1);
  return row?.deletedAt != null;
}

beforeAll(async () => {
  const [org] = await db
    .insert(organizations)
    .values({
      slug: `rettest-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Retention Test Org",
    })
    .returning();
  orgId = org!.id;
  await db.insert(quotas).values({ orgId, maxStorageBytes: null, usedStorageBytes: 0 });
  repo = await seedRepo("ret-repo");
  repo2 = await seedRepo("ret-repo-2");
});

afterAll(async () => {
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  const digests = [...createdDigests];
  if (digests.length) {
    await db.delete(blobs).where(inArray(blobs.digest, digests));
    for (const digest of digests) await blobStore.delete(digest).catch(() => {});
  }
});

describe("applyRetention CAS/quota reclamation (DB + MinIO)", () => {
  test("releases and reclaims only digests no surviving version needs", async () => {
    const ctx = ctxFor(repo);
    const sharedData = randomBytes();
    const uniqueData = randomBytes();
    const sharedDigest = computeDigest(sharedData);
    const uniqueDigest = computeDigest(uniqueData);
    createdDigests.add(sharedDigest);
    createdDigests.add(uniqueDigest);
    // storeBlobWithRef creates the blob + repo blob_ref + S3 object + quota charge.
    await storeBlobWithRef(ctx, { data: sharedData, kind: "layer", scope: "shared" });
    await storeBlobWithRef(ctx, { data: uniqueData, kind: "layer", scope: "unique" });
    const uniqueSize = uniqueData.byteLength;

    const pkg = await seedPackage(repo, "pkg-a");
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const v1 = await seedVersion(pkg, "1.0.0", new Date(base));
    const v2 = await seedVersion(pkg, "2.0.0", new Date(base + 1000));
    const v3 = await seedVersion(pkg, "3.0.0", new Date(base + 2000));
    // v1 and v3 share a digest; v2 has a unique one.
    await seedAsset(repo, {
      packageId: pkg,
      packageVersionId: v1,
      digest: sharedDigest,
      scope: "a@1",
      size: sharedData.byteLength,
    });
    await seedAsset(repo, {
      packageId: pkg,
      packageVersionId: v2,
      digest: uniqueDigest,
      scope: "a@2",
      size: uniqueSize,
    });
    await seedAsset(repo, {
      packageId: pkg,
      packageVersionId: v3,
      digest: sharedDigest,
      scope: "a@3",
      size: sharedData.byteLength,
    });
    await setUsedArtifacts(3);
    const beforeStorage = await usedStorage();

    const pruned = await applyRetention(repo, 1);
    expect(pruned).toBe(2);

    // v3 survives; v1, v2 soft-deleted.
    expect(await versionDeleted(v1)).toBe(true);
    expect(await versionDeleted(v2)).toBe(true);
    expect(await versionDeleted(v3)).toBe(false);

    // Shared digest is kept (surviving v3 asset needs it); unique digest released.
    expect(await repoRefExists(repo, sharedDigest)).toBe(true);
    expect(await repoRefExists(repo, uniqueDigest)).toBe(false);
    expect(await blobExists(sharedDigest)).toBe(true);
    expect(await blobExists(uniqueDigest)).toBe(false);

    // Storage decremented by exactly the unique blob's size; artifacts by 2.
    expect(await usedStorage()).toBe(beforeStorage - uniqueSize);
    expect(await usedArtifacts()).toBe(1);
  });

  test("keeps org storage charged when a pruned digest is still referenced by another repo in the org", async () => {
    const data = randomBytes();
    const digest = computeDigest(data);
    createdDigests.add(digest);
    // Charged once for the org via repo; repo2 mounts the same digest (no extra charge).
    await storeBlobWithRef(ctxFor(repo), { data, kind: "layer", scope: "m" });
    await storeBlobWithRef(ctxFor(repo2), { data, kind: "layer", scope: "m" });

    const pkg = await seedPackage(repo, "pkg-b");
    const base = Date.parse("2026-02-01T00:00:00.000Z");
    const v1 = await seedVersion(pkg, "1.0.0", new Date(base));
    const v2 = await seedVersion(pkg, "2.0.0", new Date(base + 1000));
    await seedAsset(repo, {
      packageId: pkg,
      packageVersionId: v1,
      digest,
      scope: "b@1",
      size: data.byteLength,
    });
    // v2 (surviving) references no digest, so the pruned digest has no live keeper in repo.
    await setUsedArtifacts(2);
    const beforeStorage = await usedStorage();

    const pruned = await applyRetention(repo, 1);
    expect(pruned).toBe(1);
    expect(await versionDeleted(v1)).toBe(true);
    expect(await versionDeleted(v2)).toBe(false);

    // repo's ref released, but repo2's ref keeps the blob referenced by the org.
    expect(await repoRefExists(repo, digest)).toBe(false);
    expect(await repoRefExists(repo2, digest)).toBe(true);
    expect(await blobExists(digest)).toBe(true);
    // No storage refund because the org still references the digest.
    expect(await usedStorage()).toBe(beforeStorage);
    expect(await usedArtifacts()).toBe(1);
  });
});
