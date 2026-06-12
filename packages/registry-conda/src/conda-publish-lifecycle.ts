import {
  digestHex,
  publishImmutableVersionBlobResponse,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { parseCondaPublishRequest } from "./conda-publish";
import { buildCondaVersionMeta, type CondaPackageKind, condaPackageKind } from "./conda-validation";

/** Blob/asset kind for stored Conda package files. */
export const CONDA_PACKAGE_KIND = "conda_package";

/** The conda artifact media type (octet-stream; .conda is a zip, .tar.bz2 a tarball). */
export const CONDA_MEDIA_TYPE = "application/octet-stream";

/**
 * Stable blob-ref scope for a published Conda package: `<subdir>/<filename>`.
 * This is exactly the channel-relative path a client fetches, so it doubles as
 * the artifact ref for permission checks.
 */
export function condaBlobScope(subdir: string, filename: string): string {
  return `${subdir}/${filename}`;
}

/**
 * The version string we store a package under. Conda allows multiple builds of
 * the same version, so the version key embeds the build (and, for the new
 * format, the extension) to keep each uploaded file a distinct, immutable
 * version row.
 */
export function condaVersionKey(version: string, build: string, kind: CondaPackageKind): string {
  return `${version}-${build}-${kind}`;
}

function md5Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("md5").update(bytes).digest("hex");
}

export async function handleCondaPublish(
  subdir: string,
  expectedFilename: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseCondaPublishRequest(subdir, expectedFilename, req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  const { index, artifact, filename } = parsed.plan;
  const kind = condaPackageKind(filename);
  if (kind === null) {
    return Response.json({ error: "unsupported package filename" }, { status: 400 });
  }
  const scope = condaBlobScope(subdir, filename);
  const versionKey = condaVersionKey(index.version, index.build, kind);
  const md5 = md5Hex(artifact);

  return publishImmutableVersionBlobResponse(ctx, {
    package: { name: index.name },
    version: versionKey,
    kind: CONDA_PACKAGE_KIND,
    scope,
    blob: {
      data: artifact,
      kind: CONDA_PACKAGE_KIND,
      scope,
      mediaType: CONDA_MEDIA_TYPE,
    },
    metadata: (stored) =>
      buildCondaVersionMeta(index, {
        subdir,
        filename,
        packageKind: kind,
        digest: stored.digest,
        sha256: digestHex(stored.digest),
        md5,
        size: artifact.length,
      }),
    sizeBytes: artifact.length,
    scan: {
      name: index.name,
      version: index.version,
      mediaType: CONDA_MEDIA_TYPE,
    },
    asset: (stored) => ({
      role: CONDA_PACKAGE_KIND,
      scope,
      path: scope,
      mediaType: CONDA_MEDIA_TYPE,
      metadata: {
        name: index.name,
        version: index.version,
        build: index.build,
        subdir,
        filename,
        sha256: digestHex(stored.digest),
        md5,
      },
    }),
    // Conda packages are immutable: a re-publish of the same file conflicts.
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, versionKey),
    conflictResponse: () => Response.json({ error: "package already exists" }, { status: 409 }),
    successResponse: () =>
      Response.json(
        { ok: true, name: index.name, version: index.version, subdir, filename },
        { status: 201 },
      ),
  });
}
