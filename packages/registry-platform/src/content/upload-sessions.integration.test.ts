import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db, eq, inArray, organizations, repositories, uploadSessions } from "@hootifactory/db";
import { blobStore } from "@hootifactory/storage";
import { UPLOAD_STATE } from "@hootifactory/types";
import { reapExpiredContentUploadSessions } from "./upload-sessions";

// DB+MinIO-backed coverage for the upload-session reaper. Issue #314 split it
// into a DB-only abort phase and a post-commit storage sweep: these tests pin
// that staged objects actually disappear from MinIO, that finalized rows are
// removed only after their storage cleanup succeeded, and that previously
// 'aborted' rows with leftover storage are retried instead of leaking forever.

let orgId = "";
let repoId = "";
const stagedKeys = new Set<string>();
const sessionIds = new Set<string>();

function stagingKey(): string {
  const key = `staging/reap-test-${crypto.randomUUID()}`;
  stagedKeys.add(key);
  return key;
}

async function insertSession(input: {
  state: (typeof UPLOAD_STATE)[keyof typeof UPLOAD_STATE];
  expiresAt: Date;
  storageKey: string;
  multipart?: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(uploadSessions)
    .values({
      repositoryId: repoId,
      scope: "reap-test",
      storageKey: input.storageKey,
      offsetBytes: 3,
      state: input.state,
      multipart: input.multipart ?? null,
      expiresAt: input.expiresAt,
    })
    .returning({ id: uploadSessions.id });
  sessionIds.add(row!.id);
  return row!.id;
}

async function sessionState(id: string): Promise<string | null> {
  const [row] = await db
    .select({ state: uploadSessions.state })
    .from(uploadSessions)
    .where(eq(uploadSessions.id, id))
    .limit(1);
  return row?.state ?? null;
}

beforeAll(async () => {
  const [org] = await db
    .insert(organizations)
    .values({ slug: `reaptest-${crypto.randomUUID().slice(0, 8)}`, displayName: "Reap Test Org" })
    .returning();
  orgId = org!.id;
  const [repo] = await db
    .insert(repositories)
    .values({
      orgId,
      name: "reap-repo",
      moduleId: "test",
      mountPath: `${orgId}/reap-repo`,
      storagePrefix: `${orgId}/reap-repo`,
    })
    .returning({ id: repositories.id });
  repoId = repo!.id;
});

afterAll(async () => {
  const ids = [...sessionIds];
  if (ids.length) await db.delete(uploadSessions).where(inArray(uploadSessions.id, ids));
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const key of stagedKeys) await blobStore.deleteKey(key).catch(() => {});
});

describe("reapExpiredContentUploadSessions (DB + MinIO)", () => {
  test("aborts expired sessions and removes their staged objects post-commit", async () => {
    const expiredKey = stagingKey();
    const chunkKey = stagingKey();
    const liveKey = stagingKey();
    await blobStore.putAtKey(expiredKey, new Uint8Array([1, 2, 3]));
    await blobStore.putAtKey(chunkKey, new Uint8Array([4, 5, 6]));
    await blobStore.putAtKey(liveKey, new Uint8Array([7, 8, 9]));

    const expiredId = await insertSession({
      state: UPLOAD_STATE.open,
      expiresAt: new Date(Date.now() - 60_000),
      storageKey: expiredKey,
      multipart: JSON.stringify({ uploadId: "m1", chunks: [{ key: chunkKey, size: 3 }] }),
    });
    const liveId = await insertSession({
      state: UPLOAD_STATE.open,
      expiresAt: new Date(Date.now() + 600_000),
      storageKey: liveKey,
    });

    const result = await reapExpiredContentUploadSessions({ limit: 50 });
    expect(result.aborted).toBeGreaterThanOrEqual(1);
    expect(result.cleaned).toBeGreaterThanOrEqual(1);

    // The expired session's staged bytes are gone and its row was finalized
    // (deleted) only after the storage cleanup succeeded.
    expect(await blobStore.existsKey(expiredKey)).toBe(false);
    expect(await blobStore.existsKey(chunkKey)).toBe(false);
    expect(await sessionState(expiredId)).toBeNull();

    // The live session is untouched: still open, staged bytes intact.
    expect(await sessionState(liveId)).toBe(UPLOAD_STATE.open);
    expect(await blobStore.existsKey(liveKey)).toBe(true);
  });

  test("retries cleanup for sessions already marked aborted with leftover storage", async () => {
    // Simulates an abort path whose best-effort S3 delete failed: the row sits in
    // 'aborted' with its staged object still present. The reaper must sweep it.
    const leftoverKey = stagingKey();
    await blobStore.putAtKey(leftoverKey, new Uint8Array([9, 9, 9]));
    const abortedId = await insertSession({
      state: UPLOAD_STATE.aborted,
      expiresAt: new Date(Date.now() - 60_000),
      storageKey: leftoverKey,
    });

    const result = await reapExpiredContentUploadSessions({ limit: 50 });
    expect(result.cleaned).toBeGreaterThanOrEqual(1);
    expect(await blobStore.existsKey(leftoverKey)).toBe(false);
    expect(await sessionState(abortedId)).toBeNull();
  });

  test("committed sessions are reaped and their staged objects cleaned up", async () => {
    const committedKey = stagingKey();
    await blobStore.putAtKey(committedKey, new Uint8Array([1]));
    const committedId = await insertSession({
      state: UPLOAD_STATE.committed,
      expiresAt: new Date(Date.now() - 60_000),
      storageKey: committedKey,
    });

    await reapExpiredContentUploadSessions({ limit: 50 });
    expect(await sessionState(committedId)).toBeNull();
    expect(await blobStore.existsKey(committedKey)).toBe(false);
  });
});
