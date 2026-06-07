import { publishImmutableVersionBlob, type RegistryRequestContext } from "@hootifactory/registry";
import { buildAlpineVersionMeta } from "./alpine-meta";
import {
  apkFilename,
  isValidAlpineArch,
  isValidAlpineName,
  isValidAlpineVersion,
} from "./alpine-validation";
import { parseApk } from "./apk-parse";

/** Blob/asset kind for stored `.apk` files. */
export const ALPINE_APK_KIND = "alpine_apk";
const APK_MEDIA_TYPE = "application/vnd.alpine.apk";

/** Stable blob-ref scope for a published `.apk`: `<arch>/<name>-<version>.apk`. */
export function alpineBlobScope(arch: string, filename: string): string {
  return `${arch}/${filename}`;
}

export interface AlpinePublishResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Publish a `.apk` into `<arch>`. The body is the raw package; we parse its
 * `.PKGINFO`, store the blob, and persist the metadata the APKINDEX is rebuilt
 * from. The on-disk `<arch>` segment must match the package's own `arch` field.
 */
export async function handleAlpinePublish(
  arch: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<AlpinePublishResult> {
  const bytes = new Uint8Array(await req.arrayBuffer());
  const parsed = parseApk(bytes);
  if (!parsed.ok) {
    const message =
      parsed.reason === "missing_pkginfo"
        ? "package is missing a valid .PKGINFO"
        : "malformed .apk archive";
    return { status: 422, body: { error: message } };
  }

  const { info, checksum } = parsed;
  if (
    !isValidAlpineName(info.name) ||
    !isValidAlpineVersion(info.version) ||
    !isValidAlpineArch(info.arch)
  ) {
    return { status: 422, body: { error: "package has an invalid name, version, or arch" } };
  }
  if (info.arch !== arch) {
    return {
      status: 400,
      body: { error: `package arch '${info.arch}' does not match upload arch '${arch}'` },
    };
  }

  const filename = apkFilename(info.name, info.version);
  const scope = alpineBlobScope(arch, filename);

  const result = await publishImmutableVersionBlob(ctx, {
    package: { name: info.name },
    version: info.version,
    kind: ALPINE_APK_KIND,
    scope,
    blob: {
      data: bytes,
      kind: ALPINE_APK_KIND,
      scope,
      mediaType: APK_MEDIA_TYPE,
    },
    metadata: (stored) =>
      buildAlpineVersionMeta(info, {
        digest: stored.digest,
        checksum,
        size: bytes.byteLength,
        filename,
      }),
    sizeBytes: bytes.byteLength,
    scan: {
      name: info.name,
      version: info.version,
      mediaType: APK_MEDIA_TYPE,
    },
    asset: () => ({
      role: ALPINE_APK_KIND,
      scope,
      path: scope,
      mediaType: APK_MEDIA_TYPE,
      metadata: { arch, name: info.name, version: info.version, checksum },
    }),
    // `.apk` artifacts are immutable: a re-publish of an existing version conflicts.
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, info.version),
  });

  if (!result.ok) {
    return { status: 409, body: { error: "version already exists" } };
  }
  return {
    status: 201,
    body: { ok: true, name: info.name, version: info.version, arch },
  };
}
