import { and, blobRefs, db, eq, repositories, uploadSessions } from "@hootifactory/db";
import type { RegistryRequestContext } from "@hootifactory/registry";
import type { Tx } from "../governance/quota";

export type OciUploadSessionRow = typeof uploadSessions.$inferSelect;

export interface OciMountSourceRow {
  orgId: string;
  id: string;
  mountPath: string;
  visibility: "private" | "public";
  scope: string;
}

export interface OciUploadSessionMutations {
  updateOpen(patch: { offsetBytes: number; multipart: string }): Promise<void>;
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
      updateOpen: async (patch) => {
        await tx
          .update(uploadSessions)
          .set({ offsetBytes: patch.offsetBytes, multipart: patch.multipart })
          .where(openOciUploadSessionWhere(ctx, opts.scope, opts.uuid));
      },
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

function openOciUploadSessionWhere(ctx: RegistryRequestContext, scope: string, uuid: string) {
  return and(
    eq(uploadSessions.id, uuid),
    eq(uploadSessions.repositoryId, ctx.repo.id),
    eq(uploadSessions.scope, scope),
    eq(uploadSessions.state, "open"),
  );
}
