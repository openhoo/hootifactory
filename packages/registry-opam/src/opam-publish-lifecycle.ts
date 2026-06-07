import {
  digestHex,
  publishImmutableVersionBlob,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { parseOpamPublishRequest } from "./opam-publish";
import { buildOpamVersionMeta } from "./opam-validation";

/** Blob/asset kind for stored opam source archives. */
export const OPAM_ARCHIVE_KIND = "opam_archive";

/** Stable blob-ref scope for a published opam source archive. */
export function opamBlobScope(name: string, version: string, filename: string): string {
  return `${name}@${version}/${filename}`;
}

/** Repository-relative archive path the opam `url.src` points at. */
export function opamArchivePath(name: string, version: string, filename: string): string {
  return `archives/${name}/${version}/${filename}`;
}

export async function handleOpamPublish(
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseOpamPublishRequest(req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  const { manifest, archive, filename } = parsed.plan;
  const name = manifest.name;
  const version = manifest.version;
  const scope = opamBlobScope(name, version, filename);

  const result = await publishImmutableVersionBlob(ctx, {
    package: { name },
    version,
    kind: OPAM_ARCHIVE_KIND,
    scope,
    blob: {
      data: archive,
      kind: OPAM_ARCHIVE_KIND,
      scope,
      mediaType: "application/gzip",
    },
    metadata: (stored) =>
      buildOpamVersionMeta(manifest, {
        digest: stored.digest,
        sha256: digestHex(stored.digest),
        filename,
      }),
    sizeBytes: archive.length,
    scan: {
      name,
      version,
      mediaType: "application/gzip",
    },
    asset: (stored) => ({
      role: OPAM_ARCHIVE_KIND,
      scope,
      path: opamArchivePath(name, version, filename),
      mediaType: "application/gzip",
      metadata: { name, version, sha256: digestHex(stored.digest) },
    }),
    // opam source archives are immutable: re-publishing an existing version conflicts.
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, version),
  });
  if (!result.ok) {
    return Response.json({ error: "version already exists" }, { status: 409 });
  }
  return Response.json({ ok: true, name, version }, { status: 201 });
}
