import type {
  RegistryOciUploadSessionMutations,
  RegistryOciUploadSessionRow,
} from "@hootifactory/registry";
import {
  computeDigest,
  Errors,
  parseRegistryInput,
  type RegistryRequestContext,
  stagingKey,
  storeRegistryBlobStreamWithRef,
  storeRegistryBlobWithRef,
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
    await storeRegistryBlobWithRef(ctx, {
      data: bytes,
      kind: "oci_layer",
      scope: image,
      asset: {
        role: "oci_layer",
        scope: image,
        path: `${image}/blobs/${digest}`,
        mediaType: "application/octet-stream",
      },
    });
    return buildOciBlobCreatedResponse({ ctx, image, digest });
  }

  const uuid = crypto.randomUUID();
  const key = stagingKey(uuid);
  await ctx.data.oci.createUploadSession({
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
  const offset = await ctx.data.oci.withLockedUploadSession({
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
      const next = await appendUploadChunk(openSession, chunk, ctx);
      await mutations.updateOpen({ offsetBytes: next.offset, multipart: next.multipart });
      return next.offset;
    },
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
  const parsedUuid = parseUploadUuid(uuid);
  const committed = await ctx.data.oci.withLockedUploadSession({
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
      const stored = await storeRegistryBlobStreamWithRef(ctx, {
        data: uploadChunkStream(ctx, state.chunks, chunk),
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
        if (err instanceof Error && err.name === "InvalidDigestError") {
          throw Errors.digestInvalid({ expected: digest, error: err.message });
        }
        throw err;
      });
      await mutations.commit(stored.size);
      return { size: stored.size, storageKey: openSession.storageKey, chunks: state.chunks };
    },
  });
  await ctx.data.content.staging.deleteKey(committed.storageKey).catch(() => {});
  await deleteUploadChunks(ctx, committed.chunks);

  return buildOciUploadCommittedResponse({ ctx, image, digest, size: committed.size });
}

export async function cancelUpload(
  image: string,
  uuid: string,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsedUuid = parseUploadUuid(uuid);
  await ctx.data.oci.withLockedUploadSession({
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
  const sources = (await input.ctx.data.oci.listMountSources(input.mount)).map((source) => ({
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
  return ctx.data.oci.loadUploadSession({ scope: image, uuid });
}

async function loadOpenSession(image: string, uuid: string, ctx: RegistryRequestContext) {
  const session = await loadSession(image, uuid, ctx);
  if (!session) throw Errors.blobUploadUnknown({ uuid });
  await assertOpenSession({
    image,
    uuid,
    ctx,
    session,
    markAborted: () => ctx.data.oci.markUploadSessionAborted({ scope: image, uuid }),
  });
  return session;
}

async function assertLoadedOpenSession(input: {
  image: string;
  uuid: string;
  ctx: RegistryRequestContext;
  session: RegistryOciUploadSessionRow | null;
  mutations: RegistryOciUploadSessionMutations;
}): Promise<RegistryOciUploadSessionRow> {
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
    await ctx.data.content.staging.putKey(key, chunk);
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
