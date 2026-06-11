import { Errors, parseJsonWithSchema, z } from "@hootifactory/core";
import { and, blobRefs, db, eq, ne, repositories, sql, uploadSessions } from "@hootifactory/db";
import type {
  RegistryBlobRefKind,
  RegistryRequestContext,
  RegistryStoredBlob,
  RegistryUploadedBlob,
} from "@hootifactory/registry";
import { blobStore } from "@hootifactory/storage";
import { UPLOAD_STATE } from "@hootifactory/types";
import { commitUploadedBlobRefTx } from "../content";
import { assertStorageQuotaRowAllows, lockOrgQuotaTx, type Tx } from "../governance/quota";
import { rowsFromExecute, stringField } from "../runtime/raw-rows";

export type ContentUploadSessionRow = typeof uploadSessions.$inferSelect;

export interface ContentMountSourceRow {
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

const ContentUploadChunkCandidateSchema = z.looseObject({
  key: z.string().min(1),
});

const ContentUploadChunkListSchema = z.looseObject({
  chunks: z.array(z.unknown()).optional(),
});

export interface ContentUploadSessionMutations {
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

export async function createContentUploadSession(
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
    state: UPLOAD_STATE.open,
    expiresAt: input.expiresAt,
  });
}

export async function loadContentUploadSession(
  ctx: RegistryRequestContext,
  opts: { scope: string; uuid: string },
): Promise<ContentUploadSessionRow | null> {
  return loadContentUploadSessionWith(opts.scope, opts.uuid, ctx);
}

export async function withLockedContentUploadSession<T>(
  ctx: RegistryRequestContext,
  opts: {
    scope: string;
    uuid: string;
    run: (
      session: ContentUploadSessionRow | null,
      mutations: ContentUploadSessionMutations,
    ) => Promise<T>;
  },
): Promise<T> {
  return db.transaction(async (tx) => {
    const session = await loadContentUploadSessionWith(opts.scope, opts.uuid, ctx, tx);
    const mutations: ContentUploadSessionMutations = {
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
          .where(openContentUploadSessionWhere(ctx, opts.scope, opts.uuid));
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
          .set({ state: UPLOAD_STATE.committed, offsetBytes })
          .where(openContentUploadSessionWhere(ctx, opts.scope, opts.uuid));
      },
      markAborted: async () => {
        await tx
          .update(uploadSessions)
          .set({ state: UPLOAD_STATE.aborted })
          .where(openContentUploadSessionWhere(ctx, opts.scope, opts.uuid));
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

export async function markContentUploadSessionAborted(
  ctx: RegistryRequestContext,
  opts: { scope: string; uuid: string },
): Promise<void> {
  await db
    .update(uploadSessions)
    .set({ state: UPLOAD_STATE.aborted })
    .where(openContentUploadSessionWhere(ctx, opts.scope, opts.uuid));
}

export async function reapExpiredContentUploadSessions(
  input: { limit?: number; now?: Date } = {},
): Promise<{ aborted: number }> {
  const limit = Math.max(1, Math.floor(input.limit ?? 100));
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const sessions = rowsFromExecute(
      await tx.execute(sql`
        select id, storage_key as "storageKey", multipart
          from upload_sessions
         where state = ${UPLOAD_STATE.open}
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
      await deleteContentUploadSessionStorage(session);
      const rows = await tx
        .update(uploadSessions)
        .set({ state: UPLOAD_STATE.aborted, updatedAt: new Date() })
        .where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.state, UPLOAD_STATE.open)))
        .returning({ id: uploadSessions.id });
      aborted += rows.length;
    }
    return { aborted };
  });
}

export async function listContentMountSources(digest: string): Promise<ContentMountSourceRow[]> {
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

function expiredUploadSessionRow(row: unknown): ExpiredUploadSessionRow | null {
  const id = stringField(row, "id");
  const storageKey = stringField(row, "storageKey") ?? stringField(row, "storage_key");
  const multipart = stringField(row, "multipart");
  return id && storageKey ? { id, storageKey, multipart } : null;
}

function uploadChunkKeys(raw: string | null): string[] {
  if (!raw) return [];
  const decoded = parseJsonWithSchema(ContentUploadChunkListSchema, raw);
  return (decoded?.chunks ?? []).flatMap((chunk) => {
    const parsed = ContentUploadChunkCandidateSchema.safeParse(chunk);
    return parsed.success ? [parsed.data.key] : [];
  });
}

async function deleteContentUploadSessionStorage(session: {
  storageKey: string;
  multipart: string | null;
}): Promise<void> {
  await blobStore.deleteKey(session.storageKey).catch(() => {});
  await Promise.all(
    uploadChunkKeys(session.multipart).map((key) => blobStore.deleteKey(key).catch(() => {})),
  );
}

async function loadContentUploadSessionWith(
  scope: string,
  uuid: string,
  ctx: RegistryRequestContext,
  tx?: Tx,
): Promise<ContentUploadSessionRow | null> {
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

function openContentUploadSessionWhere(ctx: RegistryRequestContext, scope: string, uuid: string) {
  return and(
    eq(uploadSessions.id, uuid),
    eq(uploadSessions.repositoryId, ctx.repo.id),
    eq(uploadSessions.scope, scope),
    eq(uploadSessions.state, "open"),
  );
}
