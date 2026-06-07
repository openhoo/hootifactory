import {
  digestHex,
  publishImmutableVersionBlob,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { type CranPublishPlan, parseCranPublishRequest } from "./cran-publish";
import { type CranFilenameParts, cranTarballFilename } from "./cran-validation";

/** Blob/asset kind for stored CRAN source tarballs. */
export const CRAN_TARBALL_KIND = "cran_tarball";

const TARBALL_MEDIA_TYPE = "application/gzip";

/** Stable blob-ref scope for a published CRAN source tarball. */
export function cranBlobScope(name: string, version: string): string {
  return `src/contrib/${cranTarballFilename(name, version)}`;
}

/** Build the persisted per-version metadata from the parsed plan + stored blob. */
function buildCranVersionMeta(
  plan: CranPublishPlan,
  blob: { digest: string; sizeBytes: number },
): Record<string, unknown> {
  return {
    name: plan.name,
    version: plan.version,
    controlFields: plan.controlFields,
    deps: plan.deps,
    blobDigest: blob.digest,
    sha256: digestHex(blob.digest),
    md5: plan.md5,
    sizeBytes: blob.sizeBytes,
  };
}

export async function handleCranPublish(
  filenameParts: CranFilenameParts,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseCranPublishRequest(filenameParts, req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  const { plan } = parsed;
  const scope = cranBlobScope(plan.name, plan.version);

  const result = await publishImmutableVersionBlob(ctx, {
    package: { name: plan.name },
    version: plan.version,
    kind: CRAN_TARBALL_KIND,
    scope,
    blob: {
      data: plan.tarball,
      kind: CRAN_TARBALL_KIND,
      scope,
      mediaType: TARBALL_MEDIA_TYPE,
    },
    metadata: (stored) =>
      buildCranVersionMeta(plan, { digest: stored.digest, sizeBytes: plan.tarball.length }),
    sizeBytes: plan.tarball.length,
    scan: { name: plan.name, version: plan.version, mediaType: TARBALL_MEDIA_TYPE },
    asset: (stored) => ({
      role: CRAN_TARBALL_KIND,
      scope,
      path: cranTarballFilename(plan.name, plan.version),
      mediaType: TARBALL_MEDIA_TYPE,
      metadata: { package: plan.name, version: plan.version, sha256: digestHex(stored.digest) },
    }),
    // CRAN source tarballs are immutable: a re-publish of an existing version conflicts.
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, plan.version),
  });
  if (!result.ok) {
    return Response.json({ error: "version already exists" }, { status: 409 });
  }
  return Response.json({ ok: true, package: plan.name, version: plan.version }, { status: 201 });
}
