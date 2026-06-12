import {
  computeDigest,
  digestHex,
  findRegistryPackage,
  publishImmutableVersionBlobResponse,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { ansibleBadRequest, ansibleConflict, ansibleErrorResponse } from "./ansible-errors";
import { type AnsibleUploadPlan, parseAnsibleUploadRequest } from "./ansible-publish";
import { type AnsibleVersionMeta, ansibleArtifactFile } from "./ansible-validation";

const ARTIFACT_MEDIA_TYPE = "application/gzip";
const ARTIFACT_BLOB_KIND = "ansible_collection";

/**
 * Both `artifactDigest` (which resolves the download blob) and the advertised
 * `artifactSha256` are derived from the *stored* blob digest so the two can never
 * disagree — ansible-galaxy verifies the artifact's sha256 against the bytes it
 * downloads, which are served by `artifactDigest`. Storage hashes with sha256
 * (`sha256:<hex>`), so `digestHex(stored.digest)` is exactly the archive's sha256.
 */
export function buildAnsibleVersionMetadata(
  plan: AnsibleUploadPlan,
  digest: string,
): AnsibleVersionMeta {
  return {
    artifactDigest: digest,
    artifactSha256: digestHex(digest),
    artifactSize: plan.archiveBytes.length,
    filename: ansibleArtifactFile(plan.namespace, plan.name, plan.version),
    manifest: plan.manifest,
    published: new Date().toISOString(),
  };
}

/**
 * Handle POST /api/v3/artifacts/collections/: read the artifact, verify the
 * client-declared sha256, parse its MANIFEST, reject a duplicate version, store
 * the blob immutably, and respond with the galaxy import-task envelope (a 202
 * carrying a `task` URL the client polls until the import reports completed).
 */
export async function handleAnsiblePublish(
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseAnsibleUploadRequest(req);
  if (!parsed.ok) {
    return ansibleErrorResponse(parsed.error.code, parsed.error.message, parsed.error.status);
  }
  const { plan } = parsed;
  const { fqcn, version, scope } = plan;

  // Verify the client-declared sha256 (the multipart `sha256` field) against the
  // actual bytes *before* persisting, so an upload corrupted/truncated in transit
  // is rejected at publish rather than silently stored. `computeDigest` is the
  // canonical `sha256:<hex>` of the archive; `digestHex` drops the prefix.
  if (plan.declaredSha256 !== null) {
    const actual = digestHex(computeDigest(plan.archiveBytes));
    if (actual !== plan.declaredSha256) {
      return ansibleBadRequest("artifact sha256 does not match uploaded bytes");
    }
  }

  const existingPkg = await findRegistryPackage(ctx, fqcn);
  if (existingPkg && (await ctx.data.versions.exists(existingPkg, version))) {
    return ansibleConflict(`collection ${fqcn} version ${version} already exists`);
  }

  return publishImmutableVersionBlobResponse(ctx, {
    package: { name: fqcn },
    version,
    kind: ARTIFACT_BLOB_KIND,
    scope,
    blob: {
      data: plan.archiveBytes,
      kind: ARTIFACT_BLOB_KIND,
      scope,
      mediaType: ARTIFACT_MEDIA_TYPE,
    },
    metadata: (stored) => buildAnsibleVersionMetadata(plan, stored.digest),
    sizeBytes: plan.archiveBytes.length,
    scan: { name: fqcn, version, mediaType: ARTIFACT_MEDIA_TYPE },
    asset: () => ({
      role: ARTIFACT_BLOB_KIND,
      scope,
      path: ansibleArtifactFile(plan.namespace, plan.name, version),
      mediaType: ARTIFACT_MEDIA_TYPE,
      metadata: { namespace: plan.namespace, name: plan.name, version },
    }),
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, version),
    conflictResponse: () => ansibleConflict(`collection ${fqcn} version ${version} already exists`),
    successResponse: () => {
      // Galaxy returns 202 Accepted with a `task` URL the client polls for import
      // status. We import synchronously, so that task already reports completed (see
      // the `import` route). The id is `<fqcn>-<version>`.
      const taskUrl = `${ctx.baseUrl}/${ctx.repo.mountPath}/api/v3/imports/collections/${fqcn}-${version}/`;
      return Response.json({ task: taskUrl }, { status: 202 });
    },
  });
}
