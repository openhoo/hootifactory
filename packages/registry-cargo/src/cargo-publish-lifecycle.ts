import {
  digestHex,
  publishImmutableVersionBlob,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { buildCargoIndexEntry, cargoBlobScope, parseCargoPublishBody } from "./cargo-publish";
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
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > ctx.limits.maxUploadBytes) {
    return cargoError("payload too large", 413);
  }

  const { metadata: meta, crateBytes } = parseCargoPublishBody(
    new Uint8Array(await req.arrayBuffer()),
  );

  const name = meta.name.toLowerCase();
  const scope = cargoBlobScope(name, meta.vers);
  const result = await publishImmutableVersionBlob(ctx, {
    package: { name },
    version: meta.vers,
    kind: "generic_file",
    scope,
    blob: {
      data: crateBytes,
      kind: "generic_file",
      scope,
      mediaType: "application/octet-stream",
    },
    metadata: (stored) =>
      buildCargoPublishedMetadata(
        buildCargoIndexEntry(meta, digestHex(stored.digest)),
        stored.digest,
      ),
    sizeBytes: crateBytes.length,
    scan: {
      name,
      version: meta.vers,
      mediaType: "application/octet-stream",
    },
    asset: (stored) => ({
      role: "cargo_crate",
      scope,
      path: `${name}-${meta.vers}.crate`,
      mediaType: "application/octet-stream",
      metadata: { checksum: digestHex(stored.digest) },
    }),
    versionConflict: async (pkg) =>
      cargoVersionAlreadyPublished(await ctx.data.versions.listNames(pkg), meta.vers),
  });
  if (!result.ok) return cargoError("version already exists", 409);
  return cargoPublishSuccessResponse();
}
