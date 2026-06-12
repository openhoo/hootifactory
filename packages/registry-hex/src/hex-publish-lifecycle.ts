import {
  digestHex,
  publishImmutableVersionBlobResponse,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { hexBlobScope, parseHexPublishRequest } from "./hex-publish";
import { buildHexVersionMeta, hexTarballFile } from "./hex-validation";

export const HEX_KIND = "hex_tarball";
const TARBALL_MEDIA_TYPE = "application/octet-stream";

export { hexBlobScope };

/**
 * Handle `POST /api/publish`: read the release tarball, parse its metadata,
 * reject a duplicate release, store the tarball immutably and commit the version.
 * Mirrors the Hex API success envelope (`{url, html_url, ...}`) loosely with a
 * 201 + the release coordinates.
 */
export async function handleHexPublish(
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseHexPublishRequest(req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  const { name, version, metadata, tarball, innerChecksum, scope } = parsed.plan;

  return publishImmutableVersionBlobResponse(ctx, {
    package: { name },
    version,
    kind: HEX_KIND,
    scope,
    blob: {
      data: tarball,
      kind: HEX_KIND,
      scope,
      mediaType: TARBALL_MEDIA_TYPE,
    },
    metadata: (stored) =>
      buildHexVersionMeta(metadata, {
        digest: stored.digest,
        // Hex's `outer_checksum` is the SHA256 of the *full release `.tar` bytes*
        // (`hex_tarball:unpack` computes it from the whole Tarball binary). The
        // download route serves the stored tarball verbatim, so the sha256 of the
        // stored blob IS the outer checksum a client recomputes and verifies.
        // Storage hashes with sha256 (`sha256:<hex>`), so `digestHex` yields the
        // bare hex Hex clients expect.
        outerChecksum: digestHex(stored.digest),
        // The inner checksum is the SHA256 over the tarball's *inner* members,
        // recorded verbatim in the CHECKSUM member; fall back to the outer checksum
        // if the tarball omitted it (older format).
        innerChecksum: innerChecksum ?? digestHex(stored.digest),
      }),
    sizeBytes: tarball.length,
    scan: { name, version, mediaType: TARBALL_MEDIA_TYPE },
    asset: () => ({
      role: HEX_KIND,
      scope,
      path: hexTarballFile(name, version),
      mediaType: TARBALL_MEDIA_TYPE,
      metadata: { package: name, version, app: metadata.app },
    }),
    // Hex releases are immutable: a re-publish of an existing version conflicts.
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, version),
    conflictResponse: () => Response.json({ error: "release already exists" }, { status: 409 }),
    successResponse: (result) => {
      const url = `${ctx.baseUrl}/${ctx.repo.mountPath}/api/packages/${name}/releases/${version}`;
      const htmlUrl = `${ctx.baseUrl}/${ctx.repo.mountPath}/packages/${name}/${version}`;
      // Shape the 201 body closer to Hex's release object: `mix hex.publish` gates on
      // the status, but tooling surfaces `checksum`/`html_url` to the user. The
      // checksum is the outer sha256 (= sha256 of the stored tarball), matching what
      // the repository resource and download verify against.
      return Response.json(
        {
          url,
          html_url: htmlUrl,
          package: name,
          version,
          has_docs: false,
          checksum: digestHex(result.stored.digest),
        },
        { status: 201 },
      );
    },
  });
}
