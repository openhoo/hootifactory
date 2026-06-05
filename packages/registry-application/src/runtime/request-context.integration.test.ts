import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { artifacts, db, eq, organizations, repositories, scanOutbox } from "@hootifactory/db";
import type { ResolvedRepo } from "@hootifactory/registry";
import { createTestResolvedRepo } from "@hootifactory/registry/testing";
import { recordArtifactScanOutbox } from "./request-context";

// DB-backed coverage for the scan-queue idempotency boundary: re-publishing the
// same (org, repo, digest) must keep exactly one scan_outbox row and reset it to
// pending, while a different digest gets its own row. The conflict-target columns
// are exactly what a schema/index change could silently break, and the only prior
// coverage was Docker-gated e2e.

let orgId = "";
let repo: ResolvedRepo;

const DIGEST_A = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_B = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

async function outboxFor(digest: string) {
  const rows = await db
    .select({
      id: scanOutbox.id,
      status: scanOutbox.status,
      lockedAt: scanOutbox.lockedAt,
      lastError: scanOutbox.lastError,
    })
    .from(scanOutbox)
    .innerJoin(artifacts, eq(scanOutbox.artifactId, artifacts.id))
    .where(eq(artifacts.digest, digest));
  return rows;
}

async function artifactRows(digest: string): Promise<number> {
  const rows = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(eq(artifacts.digest, digest));
  return rows.length;
}

beforeAll(async () => {
  const [org] = await db
    .insert(organizations)
    .values({ slug: `enqtest-${crypto.randomUUID().slice(0, 8)}`, displayName: "Enqueue Test Org" })
    .returning();
  orgId = org!.id;
  const [r] = await db
    .insert(repositories)
    .values({
      orgId,
      name: "scan-repo",
      moduleId: "test",
      mountPath: `${orgId}/scan-repo`,
      storagePrefix: `${orgId}/scan-repo`,
    })
    .returning({ id: repositories.id });
  repo = createTestResolvedRepo({ id: r!.id, orgId });
});

afterAll(async () => {
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
});

describe("recordArtifactScanOutbox idempotency (DB)", () => {
  test("re-enqueueing the same digest keeps one outbox row and resets it to pending", async () => {
    const first = await recordArtifactScanOutbox(repo, {
      digest: DIGEST_A,
      mediaType: "application/octet-stream",
      name: "pkg",
      version: "1.0.0",
    });
    expect(first?.artifactId).toBeString();

    // Simulate the worker having claimed the row before the re-publish.
    await db
      .update(scanOutbox)
      .set({ status: "processing", lockedAt: new Date(), lastError: "boom" })
      .where(eq(scanOutbox.artifactId, first!.artifactId));

    const second = await recordArtifactScanOutbox(repo, {
      digest: DIGEST_A,
      mediaType: "application/octet-stream",
      name: "pkg",
      version: "1.0.1",
    });
    // Same artifact (upsert on org+repo+digest), not a new one.
    expect(second?.artifactId).toBe(first!.artifactId);
    expect(await artifactRows(DIGEST_A)).toBe(1);

    const rows = await outboxFor(DIGEST_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.lockedAt).toBeNull();
    expect(rows[0]?.lastError).toBeNull();
  });

  test("a different digest gets its own distinct outbox row", async () => {
    await recordArtifactScanOutbox(repo, {
      digest: DIGEST_B,
      mediaType: "application/octet-stream",
      name: "pkg",
      version: "2.0.0",
    });
    expect(await artifactRows(DIGEST_B)).toBe(1);
    const a = await outboxFor(DIGEST_A);
    const b = await outboxFor(DIGEST_B);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(b[0]?.id).not.toBe(a[0]?.id);
  });
});
