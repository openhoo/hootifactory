import {
  digestHex,
  publishImmutableVersionBlob,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { buildHackageVersionMeta } from "./hackage-metadata";
import { parseHackagePublishRequest } from "./hackage-publish";
import { sdistFilename } from "./hackage-validation";

const SDIST_MEDIA_TYPE = "application/gzip";

/** Stable blob-ref scope for a published Hackage sdist. */
export function hackageBlobScope(name: string, version: string): string {
  return `${name}@${version}`;
}

export async function handleHackagePublish(
  id: { name: string; version: string } | null,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseHackagePublishRequest(id, req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  const { name, version, cabal, fields, sdist } = parsed.plan;
  const scope = hackageBlobScope(name, version);

  const result = await publishImmutableVersionBlob(ctx, {
    package: { name },
    version,
    kind: "hackage_sdist",
    scope,
    blob: {
      data: sdist,
      kind: "hackage_sdist",
      scope,
      mediaType: SDIST_MEDIA_TYPE,
    },
    metadata: (stored) =>
      buildHackageVersionMeta(fields, {
        cabal,
        digest: stored.digest,
        sha256: digestHex(stored.digest),
      }),
    sizeBytes: sdist.length,
    scan: { name, version, mediaType: SDIST_MEDIA_TYPE },
    asset: (stored) => ({
      role: "hackage_sdist",
      scope,
      path: sdistFilename(name, version),
      mediaType: SDIST_MEDIA_TYPE,
      metadata: { name, version, sha256: digestHex(stored.digest) },
    }),
    // Hackage releases are immutable: a re-publish of an existing version conflicts.
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, version),
  });
  if (!result.ok) {
    return Response.json({ error: "version already exists" }, { status: 409 });
  }
  return Response.json({ ok: true, package: `${name}-${version}` }, { status: 201 });
}
