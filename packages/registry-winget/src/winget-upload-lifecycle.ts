import {
  digestHex,
  publishImmutableVersionBlob,
  type RegistryRequestContext,
  type RegistryStoredBlob,
} from "@hootifactory/registry";
import { wingetErrorResponse } from "./winget-documents";
import {
  parseWingetPublishRequest,
  type WingetPublishPlan,
  wingetInstallerScope,
  wingetUpperSha256,
} from "./winget-publish";
import type { WingetVersionMeta } from "./winget-validation";

export function wingetVersionConflictResponse(): Response {
  return wingetErrorResponse(409, "package version already exists");
}

export function wingetPublishSuccessResponse(packageIdentifier: string, version: string): Response {
  return Response.json(
    { Data: { PackageIdentifier: packageIdentifier, PackageVersion: version } },
    { status: 201 },
  );
}

/** Combine the parsed plan with the stored blob digest into final metadata. */
export function buildWingetPublishedMetadata(
  plan: Pick<WingetPublishPlan, "metadata">,
  stored: RegistryStoredBlob,
): WingetVersionMeta & Record<string, unknown> {
  return {
    ...plan.metadata,
    installerDigest: stored.digest,
    installerSha256: wingetUpperSha256(digestHex(stored.digest)),
  };
}

/**
 * Handle `PUT /api/packageManifests/:packageIdentifier` (HOOTIFACTORY
 * EXTENSION — the public winget REST source API is read-only). Stores the
 * installer blob, computes its uppercase SHA256, and commits version metadata.
 */
export async function handleWingetPublish(
  packageIdentifierRaw: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseWingetPublishRequest(packageIdentifierRaw, req);
  if (!parsed.ok) {
    return wingetErrorResponse(parsed.error.status, parsed.error.error);
  }
  const { packageIdentifier, version, filename, installerBytes } = parsed.plan;
  const lowerId = packageIdentifier.toLowerCase();
  const scope = wingetInstallerScope(packageIdentifier, version, filename);

  const result = await publishImmutableVersionBlob(ctx, {
    package: { name: lowerId },
    version,
    kind: "generic_file",
    scope,
    blob: {
      data: installerBytes,
      kind: "generic_file",
      scope,
      mediaType: "application/octet-stream",
    },
    metadata: (stored) => buildWingetPublishedMetadata(parsed.plan, stored),
    sizeBytes: installerBytes.length,
    scan: {
      name: lowerId,
      version,
      mediaType: "application/octet-stream",
    },
    asset: () => ({
      role: "winget_installer",
      scope,
      path: filename,
      mediaType: "application/octet-stream",
      metadata: { packageIdentifier, version, filename },
    }),
    // winget package versions are immutable here; a stored version (even a
    // retention tombstone) reserves the version and blocks re-publish.
    versionConflict: async (pkg) => Boolean(await ctx.data.versions.find(pkg, version)),
  });
  if (!result.ok) return wingetVersionConflictResponse();
  return wingetPublishSuccessResponse(packageIdentifier, version);
}
