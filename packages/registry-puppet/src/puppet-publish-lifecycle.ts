import {
  digestHex,
  findRegistryPackage,
  publishImmutableVersionBlobResponse,
  type RegistryRequestContext,
  type RegistryStoredBlob,
} from "@hootifactory/registry";
import { puppetErrorResponse } from "./puppet-errors";
import { type PuppetUploadPlan, parsePuppetUploadRequest } from "./puppet-publish";
import { type PuppetReleaseMeta, puppetReleaseFileName } from "./puppet-validation";

const ARCHIVE_MEDIA_TYPE = "application/gzip";

/** MD5 hex of the published archive — Forge advertises `file_md5` for clients. */
function md5Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(bytes);
  return hasher.digest("hex");
}

/**
 * Build the per-release metadata we persist. `fileSha256` is derived from the
 * *stored* blob digest (`digestHex(stored.digest)`) so the advertised hash can
 * never disagree with the bytes the download route serves (which are addressed by
 * `blobDigest`). `fileMd5` is computed from the same archive bytes.
 */
export function buildPuppetReleaseMeta(
  plan: PuppetUploadPlan,
  stored: RegistryStoredBlob,
): PuppetReleaseMeta {
  return {
    version: plan.version,
    metadata: plan.metadata,
    blobDigest: stored.digest,
    fileSha256: digestHex(stored.digest),
    fileMd5: md5Hex(plan.archiveBytes),
    fileSize: plan.archiveBytes.length,
    published: new Date().toISOString(),
  };
}

/**
 * Handle POST /v3/releases: read the module archive, parse metadata.json, reject
 * a duplicate release, store the blob immutably, and respond 201 with the release
 * slug (the Forge client treats a 2xx as a successful publish).
 */
export async function handlePuppetPublish(
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parsePuppetUploadRequest(req);
  if (!parsed.ok) {
    return puppetErrorResponse(parsed.error.message, parsed.error.status);
  }
  const { plan } = parsed;
  const { slug, version, scope } = plan;
  const releaseSlug = `${slug}-${version}`;

  const existingPkg = await findRegistryPackage(ctx, slug);
  if (existingPkg && (await ctx.data.versions.exists(existingPkg, version))) {
    return puppetErrorResponse(`release ${releaseSlug} already exists`, 409);
  }

  return publishImmutableVersionBlobResponse(ctx, {
    package: { name: slug, namespace: plan.owner },
    version,
    kind: "puppet_release",
    scope,
    blob: {
      data: plan.archiveBytes,
      kind: "puppet_release",
      scope,
      mediaType: ARCHIVE_MEDIA_TYPE,
    },
    metadata: (stored) => buildPuppetReleaseMeta(plan, stored),
    sizeBytes: plan.archiveBytes.length,
    scan: { name: slug, version, mediaType: ARCHIVE_MEDIA_TYPE },
    asset: () => ({
      role: "puppet_release",
      scope,
      path: puppetReleaseFileName(plan.owner, plan.name, version),
      mediaType: ARCHIVE_MEDIA_TYPE,
      metadata: { module: slug, owner: plan.owner },
    }),
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, version),
    conflictResponse: () => puppetErrorResponse(`release ${releaseSlug} already exists`, 409),
    successResponse: () => Response.json({ slug: releaseSlug, version }, { status: 201 }),
  });
}
