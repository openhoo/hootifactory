import type {
  RegistryUploadSessionMutations,
  RegistryUploadSessionRow,
} from "@hootifactory/registry";
import {
  type ContentAddressableRegistryRequestContext,
  Errors,
  InvalidDigestError,
  parseRegistryInput,
  type RegistryRequestContext,
  type RegistryUploadedBlob,
  stagingKey,
  storeRegistryBlobStreamWithRef,
} from "@hootifactory/registry";
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

function contentStore(ctx: RegistryRequestContext) {
  return (ctx as ContentAddressableRegistryRequestContext).data.contentStore;
}

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
    await storeRegistryBlobStreamWithRef(ctx, {
      data: req.body ?? emptyStream(),
      expectedDigest: digest,
      kind: "oci_layer",
      scope: image,
      asset: {
        role: "oci_layer",
        scope: image,
        path: `${image}/blobs/${digest}`,
        mediaType: "application/octet-stream",
      },
    }).catch((err) => {
      if (err instanceof InvalidDigestError) {
        throw Errors.digestInvalid({ expected: digest, error: err.message });
      }
      throw err;
    });
    return buildOciBlobCreatedResponse({ ctx, image, digest });
  }

  const uuid = crypto.randomUUID();
  const key = stagingKey(uuid);
  await contentStore(ctx).createUploadSession({
    id: uuid,
    scope: image,
    storageKey: key,
    offsetBytes: 0,
    expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
  });
  return buildOciUploadAcceptedResponse({ ctx, image, uuid, offset: 0 });
}

export async function uploadStatus(
  image: string,
  uuid: string,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsedUuid = parseUploadUuid(uuid);
  const session = await loadOpenSession(image, parsedUuid, ctx);
  return buildOciUploadStatusResponse({ ctx, image, uuid, offset: session.offsetBytes });
}

export async function patchUpload(
  image: string,
  uuid: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsedUuid = parseUploadUuid(uuid);
  const chunk = await bodyBytes(req);
  const pending = await contentStore(ctx).withLockedUploadSession({
    scope: image,
    uuid: parsedUuid,
    run: async (session, mutations) => {
      const openSession = await assertLoadedOpenSession({
        image,
        uuid: parsedUuid,
        ctx,
        session,
        mutations,
      });
      validateContentRange(req, openSession.offsetBytes, chunk.length);
      const next = planUploadChunk(openSession, chunk);
      await mutations.assertStagingBudget({
        nextOffsetBytes: next.offset,
        maxStagedUploadBytes: ctx.limits.maxStagedUploadBytes,
      });
      return next;
    },
  });

  let stagedKey = pending.key;
  try {
    if (stagedKey) await ctx.data.content.staging.putKey(stagedKey, chunk);

    const offset = await contentStore(ctx).withLockedUploadSession({
      scope: image,
      uuid: parsedUuid,
      run: async (session, mutations) => {
        const openSession = await assertLoadedOpenSession({
          image,
          uuid: parsedUuid,
          ctx,
          session,
          mutations,
        });
        validateContentRange(req, openSession.offsetBytes, chunk.length);
        const next = planUploadChunk(openSession, chunk, stagedKey);
        if (next.startOffset !== pending.startOffset || next.offset !== pending.offset) {
          throw Errors.blobUploadInvalid({
            reason: "upload offset changed while staging chunk",
            expected: pending.startOffset,
            actual: next.startOffset,
          });
        }
        await mutations.assertStagingBudget({
          nextOffsetBytes: next.offset,
          maxStagedUploadBytes: ctx.limits.maxStagedUploadBytes,
        });
        await mutations.updateOpen({ offsetBytes: next.offset, multipart: next.multipart });
        return next.offset;
      },
    });
    stagedKey = undefined;
    return buildOciUploadAcceptedResponse({ ctx, image, uuid, offset });
  } catch (err) {
    if (stagedKey) await ctx.data.content.staging.deleteKey(stagedKey).catch(() => {});
    throw err;
  }
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
  const parsedUuid = parseUploadUuid(uuid);
  const pending = await contentStore(ctx).withLockedUploadSession({
    scope: image,
    uuid: parsedUuid,
    run: async (session, mutations) => {
      const openSession = await assertLoadedOpenSession({
        image,
        uuid: parsedUuid,
        ctx,
        session,
        mutations,
      });
      validateContentRange(req, openSession.offsetBytes, chunk.length);
      const state = uploadMultipartState(openSession.multipart);
      const existing = state.chunks.reduce((sum, part) => sum + part.size, 0);
      assertUploadOffset(existing, openSession.offsetBytes);
      return { storageKey: openSession.storageKey, chunks: state.chunks };
    },
  });

  let uploaded: RegistryUploadedBlob | null = null;
  try {
    uploaded = await ctx.data.content
      .uploadBlobStream({
        data: uploadChunkStream(ctx, pending.chunks, chunk),
        expectedDigest: digest,
      })
      .catch((err) => {
        if (err instanceof InvalidDigestError) {
          throw Errors.digestInvalid({ expected: digest, error: err.message });
        }
        throw err;
      });

    const committed = await contentStore(ctx).withLockedUploadSession({
      scope: image,
      uuid: parsedUuid,
      run: async (session, mutations) => {
        const openSession = await assertLoadedOpenSession({
          image,
          uuid: parsedUuid,
          ctx,
          session,
          mutations,
        });
        validateContentRange(req, openSession.offsetBytes, chunk.length);
        const state = uploadMultipartState(openSession.multipart);
        const existing = state.chunks.reduce((sum, part) => sum + part.size, 0);
        assertUploadOffset(existing, openSession.offsetBytes);
        const stored = await mutations.commitBlobWithRef({
          blob: uploaded!,
          kind: "oci_layer",
          scope: image,
          mediaType: "application/octet-stream",
        });
        await mutations.commit(stored.size);
        return {
          size: stored.size,
          blobRefId: stored.blobRefId,
          storageKey: openSession.storageKey,
          chunks: state.chunks,
        };
      },
    });
    uploaded = null;
    await ctx.data.assets.upsert({
      digest,
      role: "oci_layer",
      scope: image,
      blobRefId: committed.blobRefId,
      path: `${image}/blobs/${digest}`,
      mediaType: "application/octet-stream",
      sizeBytes: committed.size,
    });
    await ctx.data.content.staging.deleteKey(committed.storageKey).catch(() => {});
    await deleteUploadChunks(ctx, committed.chunks);

    return buildOciUploadCommittedResponse({ ctx, image, digest, size: committed.size });
  } catch (err) {
    if (uploaded) await ctx.data.content.discardUploadedBlob(uploaded);
    throw err;
  }
}

export async function cancelUpload(
  image: string,
  uuid: string,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsedUuid = parseUploadUuid(uuid);
  await contentStore(ctx).withLockedUploadSession({
    scope: image,
    uuid: parsedUuid,
    run: async (session, mutations) => {
      const openSession = await assertLoadedOpenSession({
        image,
        uuid: parsedUuid,
        ctx,
        session,
        mutations,
      });
      await ctx.data.content.staging.deleteKey(openSession.storageKey).catch(() => {});
      await deleteUploadChunks(ctx, uploadMultipartState(openSession.multipart).chunks);
      await mutations.deleteSession();
    },
  });
  return new Response(null, { status: 204 });
}

async function tryCrossRepositoryMount(input: {
  image: string;
  mount: string;
  from?: string;
  ctx: RegistryRequestContext;
}): Promise<Response | null> {
  const sources = (await contentStore(input.ctx).listMountSources(input.mount)).map((source) => ({
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
    if (decision.allowed) {
      await input.ctx.data.content.ensureBlobRef({
        digest: input.mount,
        kind: "oci_layer",
        scope: input.image,
        asset: {
          role: "oci_layer",
          scope: input.image,
          path: `${input.image}/blobs/${input.mount}`,
          mediaType: "application/octet-stream",
          metadata: { mountedFrom: source.full },
        },
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
  return contentStore(ctx).loadUploadSession({ scope: image, uuid });
}

async function loadOpenSession(image: string, uuid: string, ctx: RegistryRequestContext) {
  const session = await loadSession(image, uuid, ctx);
  if (!session) throw Errors.blobUploadUnknown({ uuid });
  await assertOpenSession({
    image,
    uuid,
    ctx,
    session,
    markAborted: () => contentStore(ctx).markUploadSessionAborted({ scope: image, uuid }),
  });
  return session;
}

async function assertLoadedOpenSession(input: {
  image: string;
  uuid: string;
  ctx: RegistryRequestContext;
  session: RegistryUploadSessionRow | null;
  mutations: RegistryUploadSessionMutations;
}): Promise<RegistryUploadSessionRow> {
  const { image, uuid, ctx, session, mutations } = input;
  if (!session) throw Errors.blobUploadUnknown({ uuid });
  await assertOpenSession({
    image,
    uuid,
    ctx,
    session,
    markAborted: mutations.markAborted,
  });
  return session;
}

async function assertOpenSession(input: {
  image: string;
  uuid: string;
  ctx: RegistryRequestContext;
  session: {
    state: string;
    expiresAt: Date;
    storageKey: string;
    multipart: string | null;
  };
  markAborted: () => Promise<void>;
}): Promise<void> {
  if (input.session.state !== "open") {
    throw Errors.blobUploadUnknown({ uuid: input.uuid, state: input.session.state });
  }
  if (input.session.expiresAt.getTime() > Date.now()) return;

  await input.ctx.data.content.staging.deleteKey(input.session.storageKey).catch(() => {});
  await deleteUploadChunks(input.ctx, uploadMultipartState(input.session.multipart).chunks);
  await input.markAborted();
  throw Errors.blobUploadUnknown({ uuid: input.uuid, reason: "expired" });
}

function planUploadChunk(
  session: { storageKey: string; offsetBytes: number; multipart: string | null },
  chunk: Uint8Array,
  stagedKey?: string,
): { startOffset: number; offset: number; key?: string; multipart: string } {
  const state = uploadMultipartState(session.multipart);
  const existing = state.chunks.reduce((sum, part) => sum + part.size, 0);
  assertUploadOffset(existing, session.offsetBytes);
  const nextOffset = existing + chunk.length;
  let key: string | undefined;
  if (chunk.length > 0) {
    key = stagedKey ?? `${session.storageKey}/chunks/${state.chunks.length}-${crypto.randomUUID()}`;
    state.chunks.push({ key, size: chunk.length });
  }
  return {
    startOffset: existing,
    offset: nextOffset,
    multipart: JSON.stringify(state),
    key,
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

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}
