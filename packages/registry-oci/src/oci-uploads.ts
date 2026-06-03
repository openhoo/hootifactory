import { and, blobRefs, eq, repositories, uploadSessions } from "@hootifactory/db";
import {
  computeDigest,
  Errors,
  parseRegistryInput,
  type RegistryRequestContext,
  stagingKey,
} from "@hootifactory/registry";
import {
  ensureBlobRef,
  storeBlobStreamWithRef,
  storeBlobWithRef,
} from "@hootifactory/registry-application";
import {
  buildOciBlobCreatedResponse,
  buildOciUploadAcceptedResponse,
  buildOciUploadCommittedResponse,
  buildOciUploadStatusResponse,
} from "./oci-upload-responses";
import {
  OciCommitUploadQuerySchema,
  OciStartUploadQuerySchema,
  UploadUuidSchema,
  validateContentRange,
} from "./oci-validation";
import {
  bodyBytes,
  deleteUploadChunks,
  uploadChunkStream,
  uploadMultipartState,
} from "./upload-state";

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

type Tx = Parameters<Parameters<RegistryRequestContext["db"]["transaction"]>[0]>[0];

type MountSourceRow = {
  orgId: string;
  id: string;
  mountPath: string;
  visibility: "private" | "public";
  scope: string;
};

export async function startUpload(
  image: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const url = new URL(req.url);
  const { digest, mount, from } = parseRegistryInput(
    OciStartUploadQuerySchema,
    {
      digest: url.searchParams.get("digest") ?? undefined,
      mount: url.searchParams.get("mount") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
    },
    { code: "DIGEST_INVALID", message: "invalid upload query" },
  );

  if (mount) {
    const mounted = await tryCrossRepositoryMount({ image, mount, from, ctx });
    if (mounted) return mounted;
  }

  if (digest) {
    const bytes = await bodyBytes(req);
    if (computeDigest(bytes) !== digest) throw Errors.digestInvalid();
    await storeBlobWithRef(ctx, { data: bytes, kind: "oci_layer", scope: image });
    return buildOciBlobCreatedResponse({ ctx, image, digest });
  }

  const uuid = crypto.randomUUID();
  const key = stagingKey(uuid);
  await ctx.db.insert(uploadSessions).values({
    id: uuid,
    repositoryId: ctx.repo.id,
    scope: image,
    storageKey: key,
    offsetBytes: 0,
    state: "open",
    expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
  });
  return buildOciUploadAcceptedResponse({ ctx, image, uuid, offset: 0 });
}

export async function uploadStatus(
  image: string,
  uuid: string,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const session = await loadOpenSession(image, uuid, ctx);
  return buildOciUploadStatusResponse({ ctx, image, uuid, offset: session.offsetBytes });
}

export async function patchUpload(
  image: string,
  uuid: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const chunk = await bodyBytes(req);
  const offset = await ctx.db.transaction(async (tx) => {
    const session = await loadOpenSessionForUpdateTx(image, uuid, ctx, tx);
    validateContentRange(req, session.offsetBytes, chunk.length);
    const next = await appendUploadChunk(session, chunk, ctx);
    await tx
      .update(uploadSessions)
      .set({ offsetBytes: next.offset, multipart: next.multipart })
      .where(openSessionWhere(ctx, image, uuid));
    return next.offset;
  });
  return buildOciUploadAcceptedResponse({ ctx, image, uuid, offset });
}

export async function putUpload(
  image: string,
  uuid: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const url = new URL(req.url);
  const { digest } = parseRegistryInput(
    OciCommitUploadQuerySchema,
    { digest: url.searchParams.get("digest") ?? undefined },
    { code: "DIGEST_INVALID", message: "missing or invalid digest" },
  );

  const chunk = await bodyBytes(req);
  const committed = await ctx.db.transaction(async (tx) => {
    const session = await loadOpenSessionForUpdateTx(image, uuid, ctx, tx);
    validateContentRange(req, session.offsetBytes, chunk.length);
    const state = uploadMultipartState(session.multipart);
    const existing = state.chunks.reduce((sum, part) => sum + part.size, 0);
    assertUploadOffset(existing, session.offsetBytes);
    const stored = await storeBlobStreamWithRef(ctx, {
      data: uploadChunkStream(ctx, state.chunks, chunk),
      expectedDigest: digest,
      kind: "oci_layer",
      scope: image,
    }).catch((err) => {
      if (err instanceof Error && err.name === "InvalidDigestError") {
        throw Errors.digestInvalid({ expected: digest, error: err.message });
      }
      throw err;
    });
    await tx
      .update(uploadSessions)
      .set({ state: "committed", offsetBytes: stored.size })
      .where(openSessionWhere(ctx, image, uuid));
    return { size: stored.size, storageKey: session.storageKey, chunks: state.chunks };
  });
  await ctx.blobs.deleteKey(committed.storageKey).catch(() => {});
  await deleteUploadChunks(ctx, committed.chunks);

  return buildOciUploadCommittedResponse({ ctx, image, digest, size: committed.size });
}

export async function cancelUpload(
  image: string,
  uuid: string,
  ctx: RegistryRequestContext,
): Promise<Response> {
  await ctx.db.transaction(async (tx) => {
    const session = await loadOpenSessionForUpdateTx(image, uuid, ctx, tx);
    await ctx.blobs.deleteKey(session.storageKey).catch(() => {});
    await deleteUploadChunks(ctx, uploadMultipartState(session.multipart).chunks);
    await tx
      .delete(uploadSessions)
      .where(
        and(
          eq(uploadSessions.id, uuid),
          eq(uploadSessions.repositoryId, ctx.repo.id),
          eq(uploadSessions.scope, image),
        ),
      );
  });
  return new Response(null, { status: 204 });
}

async function tryCrossRepositoryMount(input: {
  image: string;
  mount: string;
  from?: string;
  ctx: RegistryRequestContext;
}): Promise<Response | null> {
  const sources = (
    (await input.ctx.db
      .select({
        orgId: repositories.orgId,
        id: repositories.id,
        mountPath: repositories.mountPath,
        visibility: repositories.visibility,
        scope: blobRefs.scope,
      })
      .from(blobRefs)
      .innerJoin(repositories, eq(blobRefs.repositoryId, repositories.id))
      .where(eq(blobRefs.digest, input.mount))) as MountSourceRow[]
  ).map((source) => ({
    ...source,
    full: `${source.mountPath.replace(/^v2\//, "")}/${source.scope}`,
  }));
  const pool = input.from ? sources.filter((source) => source.full === input.from) : sources;
  for (const source of pool) {
    const decision = await input.ctx.authorize("read", {
      orgId: source.orgId,
      repositoryId: source.id,
      repositoryName: source.full,
      visibility: source.visibility,
    });
    if (decision.allowed && (await input.ctx.blobs.exists(input.mount))) {
      await ensureBlobRef(input.ctx, {
        digest: input.mount,
        kind: "oci_layer",
        scope: input.image,
      });
      return buildOciBlobCreatedResponse({
        ctx: input.ctx,
        image: input.image,
        digest: input.mount,
      });
    }
  }
  return null;
}

async function loadSession(image: string, uuid: string, ctx: RegistryRequestContext) {
  const parsedUuid = parseUploadUuid(uuid);
  const [session] = await ctx.db
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.id, parsedUuid),
        eq(uploadSessions.repositoryId, ctx.repo.id),
        eq(uploadSessions.scope, image),
      ),
    )
    .limit(1);
  return session ?? null;
}

async function loadSessionForUpdateTx(
  image: string,
  uuid: string,
  ctx: RegistryRequestContext,
  tx: Tx,
) {
  const parsedUuid = parseUploadUuid(uuid);
  const [session] = await tx
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.id, parsedUuid),
        eq(uploadSessions.repositoryId, ctx.repo.id),
        eq(uploadSessions.scope, image),
      ),
    )
    .for("update")
    .limit(1);
  return session ?? null;
}

async function loadOpenSession(image: string, uuid: string, ctx: RegistryRequestContext) {
  const session = await loadSession(image, uuid, ctx);
  if (!session) throw Errors.blobUploadUnknown({ uuid });
  await assertOpenSession({ image, uuid, ctx, session });
  return session;
}

async function loadOpenSessionForUpdateTx(
  image: string,
  uuid: string,
  ctx: RegistryRequestContext,
  tx: Tx,
) {
  const session = await loadSessionForUpdateTx(image, uuid, ctx, tx);
  if (!session) throw Errors.blobUploadUnknown({ uuid });
  await assertOpenSession({ image, uuid, ctx, tx, session });
  return session;
}

async function assertOpenSession(input: {
  image: string;
  uuid: string;
  ctx: RegistryRequestContext;
  tx?: Tx;
  session: {
    state: string;
    expiresAt: Date;
    storageKey: string;
    multipart: string | null;
  };
}): Promise<void> {
  if (input.session.state !== "open") {
    throw Errors.blobUploadUnknown({ uuid: input.uuid, state: input.session.state });
  }
  if (input.session.expiresAt.getTime() > Date.now()) return;

  await input.ctx.blobs.deleteKey(input.session.storageKey).catch(() => {});
  await deleteUploadChunks(input.ctx, uploadMultipartState(input.session.multipart).chunks);
  await (input.tx ?? input.ctx.db)
    .update(uploadSessions)
    .set({ state: "aborted" })
    .where(openSessionWhere(input.ctx, input.image, input.uuid));
  throw Errors.blobUploadUnknown({ uuid: input.uuid, reason: "expired" });
}

async function appendUploadChunk(
  session: { storageKey: string; offsetBytes: number; multipart: string | null },
  chunk: Uint8Array,
  ctx: RegistryRequestContext,
): Promise<{ offset: number; multipart: string }> {
  const state = uploadMultipartState(session.multipart);
  const existing = state.chunks.reduce((sum, part) => sum + part.size, 0);
  assertUploadOffset(existing, session.offsetBytes);
  if (chunk.length > 0) {
    const key = `${session.storageKey}/chunks/${state.chunks.length}`;
    await ctx.blobs.putAtKey(key, chunk);
    state.chunks.push({ key, size: chunk.length });
  }
  return {
    offset: state.chunks.reduce((sum, part) => sum + part.size, 0),
    multipart: JSON.stringify(state),
  };
}

function assertUploadOffset(actual: number, expected: number): void {
  if (actual !== expected) {
    throw Errors.blobUploadInvalid({
      reason: "staging offset mismatch",
      expected,
      actual,
    });
  }
}

function parseUploadUuid(uuid: string): string {
  return parseRegistryInput(UploadUuidSchema, uuid, {
    code: "BLOB_UPLOAD_INVALID",
    message: "invalid upload uuid",
  });
}

function openSessionWhere(ctx: RegistryRequestContext, image: string, uuid: string) {
  return and(
    eq(uploadSessions.id, uuid),
    eq(uploadSessions.repositoryId, ctx.repo.id),
    eq(uploadSessions.scope, image),
    eq(uploadSessions.state, "open"),
  );
}
