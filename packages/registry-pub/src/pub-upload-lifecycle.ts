import {
  digestHex,
  findRegistryPackage,
  publishImmutableVersionBlobResponse,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { pubErrorResponse } from "./pub-errors";
import { pubArchiveFile } from "./pub-metadata";
import { type PubUploadPlan, parsePubUploadRequest } from "./pub-publish";
import type { PubVersionMeta } from "./pub-validation";

const ARCHIVE_MEDIA_TYPE = "application/gzip";

/**
 * Both `archiveDigest` (resolves the download blob) and the advertised
 * `archiveSha256` are derived from the *stored* blob digest so the two can never
 * disagree — pub verifies `archive_sha256` against the bytes it downloads, which
 * are served by `archiveDigest`. Storage hashes with sha256 (`sha256:<hex>`), so
 * `digestHex(stored.digest)` is exactly the archive's sha256.
 */
export function buildPubVersionMetadata(plan: PubUploadPlan, digest: string): PubVersionMeta {
  return {
    archiveDigest: digest,
    archiveSha256: digestHex(digest),
    pubspec: plan.pubspec,
    published: new Date().toISOString(),
  };
}

/**
 * Handle POST /api/packages/versions/newUpload: read the archive, parse the
 * pubspec, reject a duplicate version, store the blob immutably, and respond with
 * a 303 redirect to the finish endpoint (the pub client follows `Location`).
 */
export async function handlePubUpload(
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parsePubUploadRequest(req);
  if (!parsed.ok) {
    return pubErrorResponse(parsed.error.code, parsed.error.message, parsed.error.status);
  }
  const { plan } = parsed;
  const { packageName, version, scope } = plan;

  const existingPkg = await findRegistryPackage(ctx, packageName);
  if (existingPkg && (await ctx.data.versions.exists(existingPkg, version))) {
    return pubErrorResponse(
      "PackageExists",
      `version ${version} of package ${packageName} already exists`,
      409,
    );
  }

  return publishImmutableVersionBlobResponse(ctx, {
    package: { name: packageName },
    version,
    kind: "pub_archive",
    scope,
    blob: {
      data: plan.archiveBytes,
      kind: "pub_archive",
      scope,
      mediaType: ARCHIVE_MEDIA_TYPE,
    },
    metadata: (stored) => buildPubVersionMetadata(plan, stored.digest),
    sizeBytes: plan.archiveBytes.length,
    scan: { name: packageName, version, mediaType: ARCHIVE_MEDIA_TYPE },
    asset: () => ({
      role: "pub_archive",
      scope,
      path: pubArchiveFile(packageName, version),
      mediaType: ARCHIVE_MEDIA_TYPE,
      metadata: { package: packageName },
    }),
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, version),
    conflictResponse: () =>
      pubErrorResponse(
        "PackageExists",
        `version ${version} of package ${packageName} already exists`,
        409,
      ),
    successResponse: () => {
      const finishUrl = `${ctx.baseUrl}/${ctx.repo.mountPath}/api/packages/versions/newUploadFinish`;
      return new Response(null, { status: 303, headers: { location: finishUrl } });
    },
  });
}
