import type {
  RegistryAssetWriteInput,
  RegistryManifestHandle,
  RegistryPackageHandle,
  RegistryPackageVersionHandle,
  RegistryRequestContext,
  RegistryStoredBlob,
} from "@hootifactory/registry";
import { deleteRegistryAssetRef } from "../assets";

export function assertPackageInRepo(ctx: RegistryRequestContext, pkg: RegistryPackageHandle): void {
  if (pkg.orgId !== ctx.repo.orgId || pkg.repositoryId !== ctx.repo.id) {
    throw new Error("registry package handle does not belong to this repository");
  }
}

export function assertVersionForPackage(
  pkg: RegistryPackageHandle,
  version: RegistryPackageVersionHandle,
): void {
  if (version.packageId !== pkg.id) {
    throw new Error("registry version handle does not belong to the package");
  }
}

export function assertManifestInRepo(
  ctx: RegistryRequestContext,
  manifest: RegistryManifestHandle,
): void {
  if (manifest.repositoryId !== ctx.repo.id) {
    throw new Error("registry content manifest handle does not belong to this repository");
  }
}

export function packageId(ctx: RegistryRequestContext, pkg: RegistryPackageHandle): string {
  assertPackageInRepo(ctx, pkg);
  return pkg.id;
}

export function assetForWrite<T extends RegistryAssetWriteInput>(
  ctx: RegistryRequestContext,
  input: T,
): T {
  if (input.package) assertPackageInRepo(ctx, input.package);
  if (input.packageVersion && !input.package) {
    throw new Error("registry asset package version handle requires a package handle");
  }
  if (input.packageVersion && input.package) {
    assertVersionForPackage(input.package, input.packageVersion);
  }
  return input;
}

export function assetWithDefaults(
  ctx: RegistryRequestContext,
  asset: RegistryAssetWriteInput | undefined,
  stored: Pick<RegistryStoredBlob, "digest" | "size" | "blobRefId">,
  fallback: {
    role?: string;
    scope?: string;
    mediaType?: string;
  },
): (RegistryAssetWriteInput & { digest: string }) | null {
  if (!asset) return null;
  return assetForWrite(ctx, {
    ...asset,
    role: asset.role ?? fallback.role ?? "generic_file",
    scope: asset.scope ?? fallback.scope ?? "",
    digest: asset.digest ?? stored.digest,
    blobRefId: asset.blobRefId ?? stored.blobRefId,
    mediaType: asset.mediaType ?? fallback.mediaType ?? null,
    sizeBytes: asset.sizeBytes ?? stored.size,
  });
}

export function replacedAssetRef(input: {
  previousDigest?: string | null;
  currentDigest: string;
  kind: string;
  scope: string;
  asset?: RegistryAssetWriteInput;
}): { digest: string; scope: string; role?: string } | null {
  if (!input.previousDigest || input.previousDigest === input.currentDigest) return null;
  return {
    digest: input.previousDigest,
    scope: input.asset?.scope ?? input.scope,
    role: input.asset?.role ?? input.kind,
  };
}

export async function deleteReplacedAssetRef(
  ctx: RegistryRequestContext,
  input: Parameters<typeof replacedAssetRef>[0],
): Promise<void> {
  const ref = replacedAssetRef(input);
  if (!ref) return;
  await deleteRegistryAssetRef(ctx, ref);
}
