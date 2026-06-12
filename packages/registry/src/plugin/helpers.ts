import { BoundedLruCache, Errors, type SafeFetchOptions, safeFetch } from "@hootifactory/core";
import type { RegistryRequestContext } from "./adapter";
import type {
  RegistryAssetWriteInput,
  RegistryBlobRefKind,
  RegistryPackageHandle,
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  StoreBlobStreamWithRefInput,
  StoreBlobWithRefInput,
} from "./data";
import type { MaybePromise } from "./route-types";

export interface ServeRegistryBlobOptions {
  digest: string;
  kind: RegistryBlobRefKind;
  scope: string;
  contentType: string;
  /** Filename for the forced `content-disposition: attachment` (defaults to the digest). */
  downloadFilename?: string;
  extraHeaders?: Record<string, string>;
  blocked?: () => Response;
  req?: Request;
  etag?: string;
  notModified?: () => Response | null;
  redirect?: boolean;
  missing?: () => Response;
}

export interface ServeAssetBlobOptions
  extends Omit<ServeRegistryBlobOptions, "digest" | "contentType"> {
  role: string;
  scope: string;
  contentType?: string;
}

export interface ServeVersionBlobOptions<Metadata = unknown>
  extends Omit<ServeRegistryBlobOptions, "digest" | "downloadFilename" | "contentType"> {
  name: string;
  version: string;
  digest(input: {
    pkg: RegistryPackageRow;
    row: RegistryPackageVersionRow;
    metadata: Metadata;
  }): string | null;
  parseMetadata?(value: unknown): Metadata | null;
  contentType:
    | string
    | ((input: {
        pkg: RegistryPackageRow;
        row: RegistryPackageVersionRow;
        metadata: Metadata;
      }) => string);
  downloadFilename?:
    | string
    | ((input: {
        pkg: RegistryPackageRow;
        row: RegistryPackageVersionRow;
        metadata: Metadata;
      }) => string | undefined);
}

export type ReadBoundedDigestAlgorithm = "md5" | "sha1" | "sha256" | "sha512";

export interface ReadBoundedBytesResult {
  bytes: Uint8Array;
  digests: Partial<Record<ReadBoundedDigestAlgorithm, string>>;
}

export interface ReadBoundedBytesOptions {
  digests?: readonly ReadBoundedDigestAlgorithm[];
}

export interface UpstreamFetchOptions
  extends Omit<SafeFetchOptions, "allowedHosts" | "enforcePublicNetwork"> {
  pinHost?: string;
  allowedHosts?: string[];
  enforcePublicNetwork?: boolean;
}

export interface RepoResponseCacheEntry<Body> {
  body: Body;
  etag: string;
}

export interface RepoResponseCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

export interface RepoResponseCache<Body> {
  get(
    ctx: Pick<RegistryRequestContext, "repo">,
    key: string,
    load: () => Promise<RepoResponseCacheEntry<Body>> | RepoResponseCacheEntry<Body>,
  ): Promise<RepoResponseCacheEntry<Body>>;
  set(
    ctx: Pick<RegistryRequestContext, "repo">,
    key: string,
    entry: RepoResponseCacheEntry<Body>,
  ): void;
  clear(ctx?: Pick<RegistryRequestContext, "repo">, key?: string): void;
  size(): number;
}

export function sha1hexText(data: string): string {
  const h = new Bun.CryptoHasher("sha1");
  h.update(data);
  return h.digest("hex");
}

export function sha1hexBytes(data: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha1");
  h.update(data);
  return h.digest("hex");
}

export function ifNoneMatch(req: Request, etag: string): boolean {
  const header = req.headers.get("if-none-match");
  if (!header) return false;
  return header
    .split(",")
    .map((v) => v.trim())
    .some((v) => v === "*" || v === etag || v === `W/${etag}`);
}

export function textEtag(body: string): string {
  return `"${sha1hexText(body)}"`;
}

export function bytesEtag(body: Uint8Array): string {
  return `"${sha1hexBytes(body)}"`;
}

export function textResponseWithEtag(
  req: Request,
  body: string,
  headers: Record<string, string>,
  etag = textEtag(body),
): Response {
  if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers: { etag } });
  return new Response(body, { headers: { ...headers, etag } });
}

export function bytesResponseWithEtag(
  req: Request,
  body: Uint8Array,
  headers: Record<string, string>,
  etag = bytesEtag(body),
): Response {
  if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers: { etag } });
  return new Response(body, { headers: { ...headers, etag } });
}

export function immutableRegistryBlobCacheControl(
  ctx: Pick<RegistryRequestContext, "principal" | "repo">,
): string {
  return ctx.repo.visibility === "public" && ctx.principal.kind === "anonymous"
    ? "public, max-age=31536000, immutable"
    : "private, max-age=31536000, immutable";
}

export async function serveRegistryBlob(
  ctx: RegistryRequestContext,
  opts: ServeRegistryBlobOptions,
): Promise<Response> {
  if (!(await ctx.data.content.blobRefExists(opts))) {
    const missing = opts.missing?.();
    if (missing) return missing;
    throw Errors.notFound();
  }
  const notModified =
    opts.notModified ??
    (opts.req && opts.etag
      ? () =>
          ifNoneMatch(opts.req as Request, opts.etag as string)
            ? etagNotModified(opts.etag as string)
            : null
      : undefined);
  const extraHeaders = opts.etag
    ? { ...(opts.extraHeaders ?? {}), etag: opts.etag }
    : opts.extraHeaders;
  return ctx.data.content.serveBlobIfClean({
    digest: opts.digest,
    contentType: opts.contentType,
    downloadFilename: opts.downloadFilename,
    extraHeaders,
    blocked: opts.blocked ?? blockedByScanPolicy,
    notModified,
    redirect: opts.redirect,
  });
}

export async function serveAssetBlob(
  ctx: RegistryRequestContext,
  opts: ServeAssetBlobOptions,
): Promise<Response> {
  const asset = await ctx.data.assets.findByScope({ role: opts.role, scope: opts.scope });
  if (!asset) {
    const missing = opts.missing?.();
    if (missing) return missing;
    throw Errors.notFound();
  }
  return serveRegistryBlob(ctx, {
    ...opts,
    digest: asset.digest,
    contentType: opts.contentType ?? asset.mediaType ?? "application/octet-stream",
  });
}

export async function serveVersionBlob<Metadata = unknown>(
  ctx: RegistryRequestContext,
  opts: ServeVersionBlobOptions<Metadata>,
): Promise<Response> {
  const pkg = await findRegistryPackage(ctx, opts.name);
  if (!pkg) {
    const missing = opts.missing?.();
    if (missing) return missing;
    throw Errors.notFound();
  }
  const row = await ctx.data.versions.findLive(pkg, opts.version);
  if (!row) {
    const missing = opts.missing?.();
    if (missing) return missing;
    throw Errors.notFound();
  }
  const metadata = opts.parseMetadata
    ? opts.parseMetadata(row.metadata)
    : (row.metadata as Metadata | null);
  if (!metadata) {
    const missing = opts.missing?.();
    if (missing) return missing;
    throw Errors.notFound();
  }
  const digest = opts.digest({ pkg, row, metadata });
  if (!digest) {
    const missing = opts.missing?.();
    if (missing) return missing;
    throw Errors.notFound();
  }
  const contentType =
    typeof opts.contentType === "function"
      ? opts.contentType({ pkg, row, metadata })
      : opts.contentType;
  const downloadFilename =
    typeof opts.downloadFilename === "function"
      ? opts.downloadFilename({ pkg, row, metadata })
      : opts.downloadFilename;
  return serveRegistryBlob(ctx, { ...opts, digest, contentType, downloadFilename });
}

function etagNotModified(etag: string): Response {
  return new Response(null, { status: 304, headers: { etag } });
}

function blockedByScanPolicy(): Response {
  return new Response("blocked by scan policy", { status: 403 });
}

export function findRegistryPackage(
  ctx: RegistryRequestContext,
  name: string,
): Promise<RegistryPackageRow | null> {
  return ctx.data.packages.findByName(name);
}

export function findOrCreateRegistryPackage(
  ctx: RegistryRequestContext,
  input: { name: string; namespace?: string | null },
): Promise<RegistryPackageRow> {
  return ctx.data.packages.findOrCreate(input);
}

export async function requireRegistryPackage(
  ctx: RegistryRequestContext,
  name: string,
): Promise<RegistryPackageRow> {
  const pkg = await findRegistryPackage(ctx, name);
  if (pkg) return pkg;
  throw Errors.notFound();
}

export async function requireLiveRegistryVersion(
  ctx: RegistryRequestContext,
  pkg: RegistryPackageHandle,
  version: string,
): Promise<RegistryPackageVersionRow> {
  const row = await ctx.data.versions.findLive(pkg, version);
  if (row) return row;
  throw Errors.notFound();
}

function upstreamAllowedHost(pinHost: string): string {
  try {
    return new URL(pinHost).host;
  } catch {
    return pinHost;
  }
}

export function upstreamFetch(
  ctx: Pick<RegistryRequestContext, "limits">,
  url: string,
  opts: UpstreamFetchOptions = {},
): Promise<Response | null> {
  const { pinHost, allowedHosts, enforcePublicNetwork, ...init } = opts;
  return safeFetch(url, {
    ...init,
    allowedHosts: pinHost ? [upstreamAllowedHost(pinHost)] : allowedHosts,
    enforcePublicNetwork: enforcePublicNetwork ?? ctx.limits.enforcePublicNetwork,
  }).catch(() => null);
}

export async function readBoundedBytes(
  res: Response,
  maxBytes: number,
  opts: ReadBoundedBytesOptions = {},
): Promise<ReadBoundedBytesResult | null> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }

  const algorithms = opts.digests ?? [];
  const hashers = new Map<ReadBoundedDigestAlgorithm, Bun.CryptoHasher>();
  for (const algorithm of algorithms) {
    hashers.set(algorithm, new Bun.CryptoHasher(algorithm));
  }

  const reader = res.body?.getReader();
  if (!reader) {
    return { bytes: new Uint8Array(), digests: digestResults(hashers) };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
      for (const hasher of hashers.values()) {
        hasher.update(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, digests: digestResults(hashers) };
}

function digestResults(
  hashers: Map<ReadBoundedDigestAlgorithm, Bun.CryptoHasher>,
): Partial<Record<ReadBoundedDigestAlgorithm, string>> {
  const digests: Partial<Record<ReadBoundedDigestAlgorithm, string>> = {};
  for (const [algorithm, hasher] of hashers) {
    const hex = hasher.digest("hex");
    digests[algorithm] = algorithm === "sha256" ? `sha256:${hex}` : hex;
  }
  return digests;
}

export function repoResponseCache<Body>(
  opts: RepoResponseCacheOptions = {},
): RepoResponseCache<Body> {
  const ttlMs = opts.ttlMs;
  const cache = new BoundedLruCache<string, RepoResponseCacheEntry<Body> & { expiresAt: number }>(
    opts.maxEntries ?? 1024,
  );
  const keyFor = (ctx: Pick<RegistryRequestContext, "repo">, key: string) =>
    `${ctx.repo.id}:${key}`;
  return {
    async get(ctx, key, load) {
      const cacheKey = keyFor(ctx, key);
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { body: cached.body, etag: cached.etag };
      }
      const loaded = await load();
      cache.set(cacheKey, { ...loaded, expiresAt: ttlMs ? Date.now() + ttlMs : Infinity });
      return loaded;
    },
    set(ctx, key, entry) {
      cache.set(keyFor(ctx, key), { ...entry, expiresAt: ttlMs ? Date.now() + ttlMs : Infinity });
    },
    clear(ctx, key) {
      if (!ctx) {
        cache.clear();
        return;
      }
      if (key !== undefined) {
        cache.delete(keyFor(ctx, key));
        return;
      }
      const prefix = `${ctx.repo.id}:`;
      cache.deleteWhere((cacheKey) => cacheKey.startsWith(prefix));
    },
    size: () => cache.size,
  };
}

export function storeRegistryBlobWithRef(
  ctx: RegistryRequestContext,
  input: StoreBlobWithRefInput,
): Promise<RegistryStoredBlob> {
  return ctx.data.content.storeBlobWithRef(input);
}

export function storeRegistryBlobStreamWithRef(
  ctx: RegistryRequestContext,
  input: StoreBlobStreamWithRefInput,
): Promise<RegistryStoredBlob> {
  return ctx.data.content.storeBlobStreamWithRef(input);
}

export function releaseRegistryBlobRef(
  ctx: RegistryRequestContext,
  input: { digest: string; kind: RegistryBlobRefKind; scope: string },
): Promise<void> {
  return ctx.data.content.releaseBlobRef(input);
}

export interface CommitPackageVersionBlobInput {
  stored: RegistryStoredBlob;
  kind: RegistryBlobRefKind;
  scope: string;
  package: RegistryPackageHandle;
  version: string;
  metadata: Record<string, unknown>;
  sizeBytes: number;
  scan: {
    name?: string;
    version?: string;
    mediaType?: string;
  };
  asset?: RegistryAssetWriteInput;
}

export function commitPackageVersionBlob(
  ctx: RegistryRequestContext,
  input: CommitPackageVersionBlobInput,
): Promise<{ versionId: string } | { conflict: true }> {
  return ctx.data.versions.commitOrReleaseBlob(input);
}

export interface StoreAndCommitPackageVersionBlobInput
  extends Omit<CommitPackageVersionBlobInput, "stored"> {
  blob: StoreBlobWithRefInput;
}

export async function storeAndCommitPackageVersionBlob(
  ctx: RegistryRequestContext,
  input: StoreAndCommitPackageVersionBlobInput,
): Promise<
  | { ok: true; stored: RegistryStoredBlob; versionId: string }
  | { ok: false; stored: RegistryStoredBlob; conflict: true }
> {
  const stored = await storeRegistryBlobWithRef(ctx, input.blob);
  const result = await commitPackageVersionBlob(ctx, { ...input, stored });
  if ("conflict" in result) return { ok: false, stored, conflict: true };
  return { ok: true, stored, versionId: result.versionId };
}

export interface PublishImmutableVersionBlobInput {
  package: {
    name: string;
    namespace?: string | null;
  };
  version: string;
  blob: StoreBlobWithRefInput;
  kind: RegistryBlobRefKind;
  scope: string;
  metadata(stored: RegistryStoredBlob): Record<string, unknown>;
  sizeBytes: number;
  scan: CommitPackageVersionBlobInput["scan"];
  asset?: (stored: RegistryStoredBlob) => RegistryAssetWriteInput;
  versionConflict?: (pkg: RegistryPackageHandle) => Promise<boolean>;
}

export type PublishImmutableVersionBlobSuccess = {
  ok: true;
  pkg: RegistryPackageRow;
  stored: RegistryStoredBlob;
  versionId: string;
};

export type PublishImmutableVersionBlobConflict = {
  ok: false;
  pkg: RegistryPackageRow;
  conflict: true;
};

export type PublishImmutableVersionBlobResult =
  | PublishImmutableVersionBlobSuccess
  | PublishImmutableVersionBlobConflict;

export interface PublishImmutableVersionBlobMappedInput<Output>
  extends PublishImmutableVersionBlobInput {
  conflict(result: PublishImmutableVersionBlobConflict): MaybePromise<Output>;
  success(result: PublishImmutableVersionBlobSuccess): MaybePromise<Output>;
}

export interface PublishImmutableVersionBlobResponseInput extends PublishImmutableVersionBlobInput {
  conflictResponse?: (result: PublishImmutableVersionBlobConflict) => MaybePromise<Response>;
  successResponse?: (result: PublishImmutableVersionBlobSuccess) => MaybePromise<Response>;
}

export async function publishImmutableVersionBlob(
  ctx: RegistryRequestContext,
  input: PublishImmutableVersionBlobInput,
): Promise<PublishImmutableVersionBlobResult> {
  const pkg = await findOrCreateRegistryPackage(ctx, input.package);
  if (await input.versionConflict?.(pkg)) {
    return { ok: false, pkg, conflict: true };
  }
  const stored = await storeRegistryBlobWithRef(ctx, input.blob);
  const result = await commitPackageVersionBlob(ctx, {
    stored,
    kind: input.kind,
    scope: input.scope,
    package: pkg,
    version: input.version,
    metadata: input.metadata(stored),
    sizeBytes: input.sizeBytes,
    scan: input.scan,
    asset: input.asset?.(stored),
  });
  if ("conflict" in result) return { ok: false, pkg, conflict: true };
  return { ok: true, pkg, stored, versionId: result.versionId };
}

export async function publishImmutableVersionBlobMapped<Output>(
  ctx: RegistryRequestContext,
  input: PublishImmutableVersionBlobMappedInput<Output>,
): Promise<Output> {
  const result = await publishImmutableVersionBlob(ctx, input);
  return result.ok ? input.success(result) : input.conflict(result);
}

export async function publishImmutableVersionBlobResponse(
  ctx: RegistryRequestContext,
  input: PublishImmutableVersionBlobResponseInput,
): Promise<Response> {
  return publishImmutableVersionBlobMapped(ctx, {
    ...input,
    conflict: (result) =>
      input.conflictResponse?.(result) ??
      Response.json({ error: "version already exists" }, { status: 409 }),
    success: (result) =>
      input.successResponse?.(result) ?? Response.json({ ok: true }, { status: 201 }),
  });
}
