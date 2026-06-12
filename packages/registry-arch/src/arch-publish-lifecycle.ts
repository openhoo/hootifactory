import {
  publishImmutableVersionBlobResponse,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { parseArchPublishRequest } from "./arch-publish";

const PKG_MEDIA_TYPE = "application/octet-stream";

/** Blob/asset kind for stored pacman package files. */
export const ARCH_PKG_KIND = "arch_package";

/** Stable blob-ref scope for a published pacman package. */
export function archBlobScope(filename: string): string {
  return filename;
}

export async function handleArchPublish(
  fileParam: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseArchPublishRequest(fileParam, req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  const { pkgname, version, filename, bytes, metadata } = parsed.plan;
  const scope = archBlobScope(filename);

  return publishImmutableVersionBlobResponse(ctx, {
    package: { name: pkgname },
    version,
    kind: ARCH_PKG_KIND,
    scope,
    blob: {
      data: bytes,
      kind: ARCH_PKG_KIND,
      scope,
      mediaType: PKG_MEDIA_TYPE,
    },
    metadata: () => ({ ...metadata }),
    sizeBytes: bytes.length,
    scan: { name: pkgname, version, mediaType: PKG_MEDIA_TYPE },
    asset: () => ({
      role: ARCH_PKG_KIND,
      scope,
      path: filename,
      mediaType: PKG_MEDIA_TYPE,
      metadata: { pkgname, pkgver: version, arch: metadata.arch },
    }),
    // Pacman packages are immutable: a re-publish of an existing version conflicts.
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, version),
    conflictResponse: () =>
      Response.json({ error: "package version already exists" }, { status: 409 }),
    successResponse: () =>
      Response.json({ ok: true, pkgname, pkgver: version, filename }, { status: 201 }),
  });
}
