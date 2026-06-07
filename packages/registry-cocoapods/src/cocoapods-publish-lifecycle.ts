import {
  digestHex,
  publishImmutableVersionBlob,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { parseCocoapodsPublishRequest } from "./cocoapods-publish";
import { buildPodVersionMeta, podArtifactFilename } from "./cocoapods-validation";

export const COCOAPODS_BLOB_KIND = "cocoapods_source";

/** Stable blob-ref scope for a published pod source archive. */
export function cocoapodsBlobScope(pod: string, version: string, filename: string): string {
  return `${pod}@${version}/${filename}`;
}

export async function handleCocoapodsPublish(
  pod: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseCocoapodsPublishRequest(pod, req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  const { podspec, artifact } = parsed.plan;
  const version = podspec.version;
  const filename = podArtifactFilename(pod, version);
  const scope = cocoapodsBlobScope(pod, version, filename);

  const result = await publishImmutableVersionBlob(ctx, {
    package: { name: pod },
    version,
    kind: COCOAPODS_BLOB_KIND,
    scope,
    blob: {
      data: artifact,
      kind: COCOAPODS_BLOB_KIND,
      scope,
      mediaType: "application/gzip",
    },
    metadata: (stored) =>
      buildPodVersionMeta(podspec, {
        digest: stored.digest,
        sha256: digestHex(stored.digest),
        filename,
      }),
    sizeBytes: artifact.length,
    scan: {
      name: pod,
      version,
      mediaType: "application/gzip",
    },
    asset: (stored) => ({
      role: COCOAPODS_BLOB_KIND,
      scope,
      path: filename,
      mediaType: "application/gzip",
      metadata: { pod, version, sha256: digestHex(stored.digest) },
    }),
    // Pod source archives are immutable: a re-publish of an existing version conflicts.
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, version),
  });
  if (!result.ok) {
    return Response.json({ error: "version already exists" }, { status: 409 });
  }
  return Response.json({ ok: true, pod, version }, { status: 201 });
}
