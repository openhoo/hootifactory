import { Errors } from "@hootifactory/core";
import { and, blobRefs, db, eq, ne, repositories, sql, uploadSessions } from "@hootifactory/db";
import type {
  RegistryBlobRefKind,
  RegistryRequestContext,
  RegistryStoredBlob,
  RegistryUploadedBlob,
} from "@hootifactory/registry";
import { blobStore } from "@hootifactory/storage";
import { commitUploadedBlobRefTx } from "../content";
import { assertStorageQuotaRowAllows, lockOrgQuotaTx, type Tx } from "../governance/quota";

export type OciUploadSessionRow = typeof uploadSessions.$inferSelect;

export interface OciMountSourceRow {
  orgId: string;
  id: string;
  mountPath: string;
  visibility: "private" | "public";
  scope: string;
}

interface ExpiredUploadSessionRow {
  id: string;
  storageKey: string;
  multipart: string | null;
}

export interface OciUploadSessionMutations {
  assertStagingBudget(input: {
    nextOffsetBytes: number;
    maxStagedUploadBytes: number;
  }): Promise<void>;
  updateOpen(patch: { offsetBytes: number; multipart: string }): Promise<void>;
  commitBlobWithRef(input: {
    blob: RegistryUploadedBlob;
    mediaType?: string;
    kind: RegistryBlobRefKind;
    scope: string;
  }): Promise<RegistryStoredBlob>;
  commit(offsetBytes: number): Promise<void>;
  markAborted(): Promise<void>;
  deleteSession(): Promise<void>;
}

export async function createOciUploadSession(
  ctx: RegistryRequestContext,
  input: {
    id: string;
    scope: string;
    storageKey: string;
    offsetBytes: number;
    expiresAt: Date;
  },
): Promise<void> {
  await db.insert(uploadSessions).values({
    id: input.id,
    repositoryId: ctx.repo.id,
    scope: input.scope,
    storageKey: input.storageKey,
    offsetBytes: input.offsetBytes,
    state: "open",
    expiresAt: input.expiresAt,
  });
}

export async function loadOciUploadSession(
  ctx: RegistryRequestContext,
  opts: { scope: string; uuid: string },
): Promise<OciUploadSessionRow | null> {
  return loadOciUploadSessionWith(opts.scope, opts.uuid, ctx);
}

export async function withLockedOciUploadSession<T>(
  ctx: RegistryRequestContext,
  opts: {
    scope: string;
    uuid: string;
    run: (session: OciUploadSessionRow | null, mutations: OciUploadSessionMutations) => Promise<T>;
  },
): Promise<T> {
  return db.transaction(async (tx) => {
    const session = await loadOciUploadSessionWith(opts.scope, opts.uuid, ctx, tx);
    const mutations: OciUploadSessionMutations = {
      assertStagingBudget: async (input) => {
        const quota = await lockOrgQuotaTx(tx, ctx.repo.orgId);
        const otherStagedBytes = await sumOpenUploadBytesForOrgTx(tx, ctx.repo.orgId, opts.uuid);
        const nextStagedBytes = otherStagedBytes + input.nextOffsetBytes;
        if (nextStagedBytes > input.maxStagedUploadBytes) {
          throw Errors.quotaExceeded({
            maxStagedUploadBytes: input.maxStagedUploadBytes,
            stagedBytes: otherStagedBytes,
            requestedStagedBytes: input.nextOffsetBytes,
          });
        }
        assertStorageQuotaRowAllows(quota, nextStagedBytes);
      },
      updateOpen: async (patch) => {
        await tx
          .update(uploadSessions)
          .set({ offsetBytes: patch.offsetBytes, multipart: patch.multipart })
          .where(openOciUploadSessionWhere(ctx, opts.scope, opts.uuid));
      },
      commitBlobWithRef: async (input) =>
        commitUploadedBlobRefTx(tx, ctx, input.blob, {
          mediaType: input.mediaType,
          kind: input.kind,
          scope: input.scope,
        }),
      commit: async (offsetBytes) => {
        await tx
          .update(uploadSessions)
          .set({ state: "committed", offsetBytes })
          .where(openOciUploadSessionWhere(ctx, opts.scope, opts.uuid));
      },
      markAborted: async () => {
        await tx
          .update(uploadSessions)
          .set({ state: "aborted" })
          .where(openOciUploadSessionWhere(ctx, opts.scope, opts.uuid));
      },
      deleteSession: async () => {
        await tx
          .delete(uploadSessions)
          .where(
            and(
              eq(uploadSessions.id, opts.uuid),
              eq(uploadSessions.repositoryId, ctx.repo.id),
              eq(uploadSessions.scope, opts.scope),
            ),
          );
      },
    };
    return opts.run(session, mutations);
  });
}

export async function markOciUploadSessionAborted(
  ctx: RegistryRequestContext,
  opts: { scope: string; uuid: string },
): Promise<void> {
  await db
    .update(uploadSessions)
    .set({ state: "aborted" })
    .where(openOciUploadSessionWhere(ctx, opts.scope, opts.uuid));
}

export async function reapExpiredOciUploadSessions(
  input: { limit?: number; now?: Date } = {},
): Promise<{ aborted: number }> {
  const limit = Math.max(1, Math.floor(input.limit ?? 100));
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const sessions = rowsFromExecute(
      await tx.execute(sql`
        select id, storage_key as "storageKey", multipart
          from upload_sessions
         where state = 'open'
           and expires_at <= ${now}
         order by expires_at asc
         limit ${limit}
         for update skip locked
      `),
    ).flatMap((row) => {
      const session = expiredUploadSessionRow(row);
      return session ? [session] : [];
    });

    let aborted = 0;
    for (const session of sessions) {
      await deleteOciUploadSessionStorage(session);
      const rows = await tx
        .update(uploadSessions)
        .set({ state: "aborted", updatedAt: new Date() })
        .where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.state, "open")))
        .returning({ id: uploadSessions.id });
      aborted += rows.length;
    }
    return { aborted };
  });
}

export async function listOciMountSources(digest: string): Promise<OciMountSourceRow[]> {
  return db
    .select({
      orgId: repositories.orgId,
      id: repositories.id,
      mountPath: repositories.mountPath,
      visibility: repositories.visibility,
      scope: blobRefs.scope,
    })
    .from(blobRefs)
    .innerJoin(repositories, eq(blobRefs.repositoryId, repositories.id))
    .where(eq(blobRefs.digest, digest));
}

function rowsFromExecute(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { rows?: unknown[] }).rows)
  ) {
    return (result as { rows: unknown[] }).rows;
  }
  return [];
}

function expiredUploadSessionRow(row: unknown): ExpiredUploadSessionRow | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : null;
  const storageKey =
    typeof record.storageKey === "string"
      ? record.storageKey
      : typeof record.storage_key === "string"
        ? record.storage_key
        : null;
  const multipart = typeof record.multipart === "string" ? record.multipart : null;
  return id && storageKey ? { id, storageKey, multipart } : null;
}

function uploadChunkKeys(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const decoded = JSON.parse(raw) as { chunks?: unknown };
    if (!Array.isArray(decoded.chunks)) return [];
    return decoded.chunks.flatMap((chunk) => {
      if (!chunk || typeof chunk !== "object") return [];
      const key = (chunk as { key?: unknown }).key;
      return typeof key === "string" && key ? [key] : [];
    });
  } catch {
    return [];
  }
}

async function deleteOciUploadSessionStorage(session: {
  storageKey: string;
  multipart: string | null;
}): Promise<void> {
  await blobStore.deleteKey(session.storageKey).catch(() => {});
  await Promise.all(
    uploadChunkKeys(session.multipart).map((key) => blobStore.deleteKey(key).catch(() => {})),
  );
}

async function loadOciUploadSessionWith(
  scope: string,
  uuid: string,
  ctx: RegistryRequestContext,
  tx?: Tx,
): Promise<OciUploadSessionRow | null> {
  const query = (tx ?? db)
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.id, uuid),
        eq(uploadSessions.repositoryId, ctx.repo.id),
        eq(uploadSessions.scope, scope),
      ),
    );
  const rows = tx ? await query.for("update").limit(1) : await query.limit(1);
  return rows[0] ?? null;
}

async function sumOpenUploadBytesForOrgTx(
  tx: Tx,
  orgId: string,
  excludeUuid: string,
): Promise<number> {
  const [row] = await tx
    .select({ bytes: sql<number>`coalesce(sum(${uploadSessions.offsetBytes}), 0)` })
    .from(uploadSessions)
    .innerJoin(repositories, eq(uploadSessions.repositoryId, repositories.id))
    .where(
      and(
        eq(repositories.orgId, orgId),
        eq(uploadSessions.state, "open"),
        ne(uploadSessions.id, excludeUuid),
      ),
    );
  return Number(row?.bytes ?? 0);
}

function openOciUploadSessionWhere(ctx: RegistryRequestContext, scope: string, uuid: string) {
  return and(
    eq(uploadSessions.id, uuid),
    eq(uploadSessions.repositoryId, ctx.repo.id),
    eq(uploadSessions.scope, scope),
    eq(uploadSessions.state, "open"),
  );
}
