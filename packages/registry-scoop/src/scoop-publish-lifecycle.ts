import {
  digestHex,
  publishImmutableVersionBlobResponse,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { parseScoopPublishRequest } from "./scoop-publish";
import { buildScoopVersionMeta } from "./scoop-validation";

/** Stable blob-ref scope for a published Scoop artifact. */
export function scoopBlobScope(app: string, version: string, filename: string): string {
  return `${app}@${version}/${filename}`;
}

export async function handleScoopPublish(
  app: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseScoopPublishRequest(app, req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  const { manifest, artifact, filename } = parsed.plan;
  const version = manifest.version;
  const scope = scoopBlobScope(app, version, filename);

  return publishImmutableVersionBlobResponse(ctx, {
    package: { name: app },
    version,
    kind: "scoop_artifact",
    scope,
    blob: {
      data: artifact,
      kind: "scoop_artifact",
      scope,
      mediaType: "application/octet-stream",
    },
    metadata: (stored) =>
      buildScoopVersionMeta(manifest, {
        digest: stored.digest,
        sha256: digestHex(stored.digest),
        filename,
      }),
    sizeBytes: artifact.length,
    scan: {
      name: app,
      version,
      mediaType: "application/octet-stream",
    },
    asset: (stored) => ({
      role: "scoop_artifact",
      scope,
      path: filename,
      mediaType: "application/octet-stream",
      metadata: { app, version, sha256: digestHex(stored.digest) },
    }),
    // Scoop artifacts are immutable: a re-publish of an existing version conflicts.
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, version),
    conflictResponse: () => Response.json({ error: "version already exists" }, { status: 409 }),
    successResponse: () => Response.json({ ok: true, app, version }, { status: 201 }),
  });
}
