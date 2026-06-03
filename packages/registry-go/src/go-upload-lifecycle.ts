import type { RegistryRequestContext } from "@hootifactory/registry";
import { type GoUploadPlan, parseGoUploadRequest, validateGoUploadPlan } from "./go-upload";
import type { GoVersionMeta } from "./go-validation";

export function goVersionConflictResponse(): Response {
  return Response.json({ error: "version already exists" }, { status: 409 });
}

export function goUploadSuccessResponse(moduleName: string, version: string): Response {
  return Response.json({ ok: true, module: moduleName, version });
}

export function buildGoPublishedMetadata(
  plan: Pick<GoUploadPlan, "metadata">,
  digest: string,
): GoVersionMeta & Record<string, unknown> {
  return {
    ...plan.metadata,
    zipDigest: digest,
  };
}

export async function handleGoUpload(
  moduleName: string,
  versionRaw: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const upload = await parseGoUploadRequest(moduleName, versionRaw, req);
  const { scope, version, zipBytes } = upload;
  const existingPkg = await ctx.data.packages.findByName(moduleName);
  if (existingPkg) {
    if (await ctx.data.versions.exists(existingPkg.id, version)) {
      return goVersionConflictResponse();
    }
  }
  const uploadError = validateGoUploadPlan(moduleName, upload);
  if (uploadError) return Response.json(uploadError.body, { status: uploadError.status });
  const pkg =
    existingPkg ??
    (await ctx.data.packages.findOrCreate({
      name: moduleName,
    }));

  const stored = await ctx.data.content.storeBlobWithRef({
    data: zipBytes,
    kind: "generic_file",
    scope,
    mediaType: "application/zip",
  });
  const result = await ctx.data.versions.commitOrReleaseBlob({
    stored,
    kind: "generic_file",
    scope,
    packageId: pkg.id,
    version,
    metadata: buildGoPublishedMetadata(upload, stored.digest),
    sizeBytes: zipBytes.length,
    scan: { name: moduleName, version, mediaType: "application/zip" },
    asset: {
      role: "go_zip",
      scope,
      path: `${version}.zip`,
      mediaType: "application/zip",
      metadata: { module: moduleName },
    },
  });
  if ("conflict" in result) {
    return goVersionConflictResponse();
  }
  return goUploadSuccessResponse(moduleName, version);
}
