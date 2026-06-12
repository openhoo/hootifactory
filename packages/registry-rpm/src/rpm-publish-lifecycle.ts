import {
  publishImmutableVersionBlobResponse,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { parseRpmPublishRequest } from "./rpm-publish";
import type { RpmVersionMeta } from "./rpm-validation";

const RPM_MEDIA_TYPE = "application/x-rpm";

export function buildRpmPublishedMetadata(
  meta: RpmVersionMeta,
): RpmVersionMeta & Record<string, unknown> {
  return { ...meta };
}

/** Blob-ref scope/kind for stored `.rpm` files. */
export const RPM_BLOB_KIND = "generic_file";
export function rpmBlobScope(file: string): string {
  return file;
}

export async function handleRpmPublish(
  routeFile: string | undefined,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseRpmPublishRequest(routeFile, req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  const { name, version, file, bytes, metadata } = parsed.plan;
  const scope = rpmBlobScope(file);

  return publishImmutableVersionBlobResponse(ctx, {
    package: { name },
    version,
    kind: RPM_BLOB_KIND,
    scope,
    blob: {
      data: bytes,
      kind: RPM_BLOB_KIND,
      scope,
      mediaType: RPM_MEDIA_TYPE,
    },
    metadata: () => buildRpmPublishedMetadata(metadata),
    sizeBytes: bytes.length,
    scan: { name, version, mediaType: RPM_MEDIA_TYPE },
    asset: () => ({
      role: "rpm_package",
      scope,
      path: file,
      mediaType: RPM_MEDIA_TYPE,
      metadata: { name, version },
    }),
    // RPM files are immutable: a duplicate name+version (incl. retention
    // tombstones) is a conflict, not a replace.
    versionConflict: async (pkg) => Boolean(await ctx.data.versions.find(pkg, version)),
    conflictResponse: () =>
      Response.json({ error: "package version already exists" }, { status: 409 }),
    successResponse: () => Response.json({ ok: true, name, version, file }, { status: 201 }),
  });
}
