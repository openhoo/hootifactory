import type { RegistryRequestContext } from "@hootifactory/registry";
import {
  commitVersionOrReleaseBlob,
  findOrCreatePackage,
  listPackageVersionNames,
  storeBlobWithRef,
} from "@hootifactory/registry-application";
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
  const pkg = await findOrCreatePackage({
    orgId: ctx.repo.orgId,
    repositoryId: ctx.repo.id,
    name,
  });
  const existingVersions = await listPackageVersionNames(pkg.id);
  if (cargoVersionAlreadyPublished(existingVersions, meta.vers)) {
    return cargoError("version already exists", 409);
  }

  const stored = await storeBlobWithRef(ctx, {
    data: crateBytes,
    kind: "generic_file",
    scope,
    mediaType: "application/octet-stream",
  });
  const indexEntry = buildCargoIndexEntry(meta, cksum);
  const result = await commitVersionOrReleaseBlob(ctx, {
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
  });
  if ("conflict" in result) {
    return cargoError("version already exists", 409);
  }
  return cargoPublishSuccessResponse();
}
