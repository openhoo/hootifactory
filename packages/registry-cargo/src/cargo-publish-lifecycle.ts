import type { RegistryRequestContext } from "@hootifactory/registry";
import {
  buildCargoIndexEntry,
  cargoBlobScope,
  digestCargoCrate,
  parseCargoPublishBody,
} from "./cargo-publish";
import {
  type CargoIndexEntry,
  type CargoVersionMeta,
  cargoVersionIdentity,
} from "./cargo-validation";

type CargoVersionRow = { version: string };

export function cargoError(detail: string, status: number): Response {
  return Response.json({ errors: [{ detail }] }, { status });
}

export function cargoVersionAlreadyPublished(
  versions: CargoVersionRow[],
  candidate: string,
): boolean {
  const identity = cargoVersionIdentity(candidate);
  return versions.some((version) => cargoVersionIdentity(version.version) === identity);
}

export function buildCargoPublishedMetadata(
  index: CargoIndexEntry,
  digest: string,
): CargoVersionMeta & Record<string, unknown> {
  return { index, crateDigest: digest };
}

export function cargoPublishSuccessResponse(): Response {
  return Response.json({ warnings: { invalid_categories: [], invalid_badges: [], other: [] } });
}

export async function handleCargoPublish(
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const { metadata: meta, crateBytes } = parseCargoPublishBody(
    new Uint8Array(await req.arrayBuffer()),
  );

  const name = meta.name.toLowerCase();
  const cksum = digestCargoCrate(crateBytes);
  const scope = cargoBlobScope(name, meta.vers);
  const pkg = await ctx.data.packages.findOrCreate({
    name,
  });
  const existingVersions = await ctx.data.versions.listNames(pkg.id);
  if (cargoVersionAlreadyPublished(existingVersions, meta.vers)) {
    return cargoError("version already exists", 409);
  }

  const stored = await ctx.data.content.storeBlobWithRef({
    data: crateBytes,
    kind: "generic_file",
    scope,
    mediaType: "application/octet-stream",
  });
  const indexEntry = buildCargoIndexEntry(meta, cksum);
  const result = await ctx.data.versions.commitOrReleaseBlob({
    stored,
    kind: "generic_file",
    scope,
    packageId: pkg.id,
    version: meta.vers,
    metadata: buildCargoPublishedMetadata(indexEntry, stored.digest),
    sizeBytes: crateBytes.length,
    scan: {
      name,
      version: meta.vers,
      mediaType: "application/octet-stream",
    },
    asset: {
      role: "cargo_crate",
      scope,
      path: `${name}-${meta.vers}.crate`,
      mediaType: "application/octet-stream",
      metadata: { checksum: cksum },
    },
  });
  if ("conflict" in result) {
    return cargoError("version already exists", 409);
  }
  return cargoPublishSuccessResponse();
}
