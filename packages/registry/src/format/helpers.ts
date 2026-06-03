import { Errors } from "@hootifactory/core";
import type { RegistryRequestContext } from "./adapter";
import type {
  RegistryAssetWriteInput,
  RegistryBlobRefKind,
  RegistryPackageHandle,
  RegistryPackageRow,
  RegistryStoredBlob,
  StoreBlobStreamWithRefInput,
  StoreBlobWithRefInput,
} from "./data";

export interface ServeRegistryBlobOptions {
  digest: string;
  kind: RegistryBlobRefKind;
  scope: string;
  contentType: string;
  extraHeaders?: Record<string, string>;
  blocked: () => Response;
  notModified?: () => Response | null;
  missing?: () => Response;
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
  return ctx.data.content.serveBlobIfClean({
    digest: opts.digest,
    contentType: opts.contentType,
    extraHeaders: opts.extraHeaders,
    blocked: opts.blocked,
    notModified: opts.notModified,
  });
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

export async function publishImmutableVersionBlob(
  ctx: RegistryRequestContext,
  input: PublishImmutableVersionBlobInput,
): Promise<
  | { ok: true; pkg: RegistryPackageRow; stored: RegistryStoredBlob; versionId: string }
  | { ok: false; pkg: RegistryPackageRow; conflict: true }
> {
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
