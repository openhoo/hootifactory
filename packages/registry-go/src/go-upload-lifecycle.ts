import {
  findRegistryPackage,
  publishImmutableVersionBlob,
  type RegistryRequestContext,
} from "@hootifactory/registry";
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
  const existingPkg = await findRegistryPackage(ctx, moduleName);
  if (existingPkg && (await ctx.data.versions.exists(existingPkg.id, version))) {
    return goVersionConflictResponse();
  }
  const uploadError = validateGoUploadPlan(moduleName, upload);
  if (uploadError) return Response.json(uploadError.body, { status: uploadError.status });

  const result = await publishImmutableVersionBlob(ctx, {
    package: { name: moduleName },
    version,
    kind: "generic_file",
    scope,
    blob: {
      data: zipBytes,
      kind: "generic_file",
      scope,
      mediaType: "application/zip",
    },
    metadata: (stored) => buildGoPublishedMetadata(upload, stored.digest),
    sizeBytes: zipBytes.length,
    scan: { name: moduleName, version, mediaType: "application/zip" },
    asset: () => ({
      role: "go_zip",
      scope,
      path: `${version}.zip`,
      mediaType: "application/zip",
      metadata: { module: moduleName },
    }),
    versionConflict: (packageId) => ctx.data.versions.exists(packageId, version),
  });
  if (!result.ok) return goVersionConflictResponse();
  return goUploadSuccessResponse(moduleName, version);
}
