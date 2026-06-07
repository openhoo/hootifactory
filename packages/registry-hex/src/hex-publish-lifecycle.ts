import {
  digestHex,
  publishImmutableVersionBlob,
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

  const result = await publishImmutableVersionBlob(ctx, {
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
        // Documented simplification: real Hex's `outer_checksum` is `hex_tarball`'s
        // hash over the tarball's inner members, which we do not recompute here.
        // This hosted impl advertises the sha256 of the whole stored tarball as the
        // outer checksum — stable, addressable, and verifiable against the exact
        // bytes the download route serves. Storage hashes with sha256
        // (`sha256:<hex>`), so `digestHex` yields the bare hex Hex clients expect.
        outerChecksum: digestHex(stored.digest),
        // The inner checksum is taken verbatim from the tarball's CHECKSUM member;
        // fall back to the outer checksum if the tarball omitted it (older format).
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
  });
  if (!result.ok) {
    return Response.json({ error: "release already exists" }, { status: 409 });
  }
  const url = `${ctx.baseUrl}/${ctx.repo.mountPath}/api/packages/${name}/releases/${version}`;
  return Response.json({ url, package: name, version }, { status: 201 });
}
