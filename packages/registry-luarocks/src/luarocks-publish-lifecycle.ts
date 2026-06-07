import {
  type RegistryPackageHandle,
  type RegistryRequestContext,
  type RegistryStoredBlob,
  releaseRegistryBlobRef,
  storeRegistryBlobWithRef,
} from "@hootifactory/registry";
import {
  type LuarocksVersionMeta,
  type ParsedArtifactFilename,
  parseLuarocksVersionMeta,
  parseRockspec,
  ROCKSPEC_ARCH,
  versionSizeBytes,
} from "./luarocks-validation";

/** Blob/asset kind for stored LuaRocks `.rock`/`.rockspec` files. */
export const LUAROCKS_BLOB_KIND = "luarocks_rock";

/** Stable blob-ref scope: `<rock>@<version>/<filename>`. */
export function luarocksBlobScope(rock: string, version: string, filename: string): string {
  return `${rock}@${version}/${filename}`;
}

type AddArchResult =
  | { ok: true; versionId: string }
  | { ok: false; reason: "arch_exists" | "version_gone" };

/**
 * Publish a single `.rock` or `.rockspec` artifact. A rockspec additionally
 * supplies the descriptive fields + dependencies merged into the version row;
 * every artifact records its arch -> blob coordinates so the manifest and
 * download routes can resolve them. Multiple archs accumulate on one version.
 */
export async function handleLuarocksPublish(
  parsed: ParsedArtifactFilename,
  filename: string,
  bytes: Uint8Array,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const rock = parsed.rock;
  const version = parsed.version;
  const arch = parsed.kind === "rockspec" ? ROCKSPEC_ARCH : parsed.arch;

  // A rockspec carries the canonical package/version/dependencies; validate it
  // and ensure it agrees with the filename.
  let rockspecFields: ReturnType<typeof parseRockspec> = null;
  if (parsed.kind === "rockspec") {
    rockspecFields = parseRockspec(new TextDecoder().decode(bytes));
    if (!rockspecFields) {
      return Response.json({ error: "malformed rockspec" }, { status: 422 });
    }
    if (rockspecFields.package !== rock || rockspecFields.version !== version) {
      return Response.json(
        { error: "rockspec package/version does not match filename" },
        { status: 422 },
      );
    }
  }

  const scope = luarocksBlobScope(rock, version, filename);
  const stored = await storeRegistryBlobWithRef(ctx, {
    data: bytes,
    kind: LUAROCKS_BLOB_KIND,
    scope,
    mediaType: "application/octet-stream",
  });

  const pkg = await ctx.data.packages.findOrCreate({ name: rock });
  const added = await addArchToVersion(ctx, {
    package: pkg,
    rock,
    version,
    arch,
    filename,
    stored,
    sizeBytes: bytes.byteLength,
    rockspecFields,
  });
  if (!added.ok) {
    if (stored.refCreated) {
      await releaseRegistryBlobRef(ctx, { digest: stored.digest, kind: LUAROCKS_BLOB_KIND, scope });
    }
    const status = added.reason === "arch_exists" ? 409 : 422;
    const error =
      added.reason === "arch_exists" ? "artifact already exists" : "version unavailable";
    return Response.json({ error }, { status });
  }

  await ctx.enqueueScan({
    digest: stored.digest,
    name: rock,
    version,
    mediaType: "application/octet-stream",
  });

  const status = req.method === "POST" ? 200 : 201;
  return Response.json({ ok: true, rock, version, arch, filename }, { status });
}

function descriptiveMeta(
  fields: ReturnType<typeof parseRockspec>,
): Pick<LuarocksVersionMeta, "summary" | "homepage" | "license" | "dependencies"> {
  if (!fields) return {};
  return {
    ...(fields.summary ? { summary: fields.summary } : {}),
    ...(fields.homepage ? { homepage: fields.homepage } : {}),
    ...(fields.license ? { license: fields.license } : {}),
    ...(fields.dependencies.length > 0 ? { dependencies: fields.dependencies } : {}),
  };
}

async function addArchToVersion(
  ctx: RegistryRequestContext,
  opts: {
    package: RegistryPackageHandle;
    rock: string;
    version: string;
    arch: string;
    filename: string;
    stored: RegistryStoredBlob;
    sizeBytes: number;
    rockspecFields: ReturnType<typeof parseRockspec>;
  },
): Promise<AddArchResult> {
  const blobEntry = {
    digest: opts.stored.digest,
    filename: opts.filename,
    sizeBytes: opts.sizeBytes,
  };
  const baseMeta: LuarocksVersionMeta = {
    rock: opts.rock,
    version: opts.version,
    ...descriptiveMeta(opts.rockspecFields),
    blobs: { [opts.arch]: blobEntry },
  };

  const created = await ctx.data.versions.create({
    package: opts.package,
    version: opts.version,
    metadata: baseMeta,
    sizeBytes: versionSizeBytes(baseMeta),
  });
  if (created) {
    await upsertArchAsset(ctx, { ...opts, versionId: created });
    return { ok: true, versionId: created };
  }

  // Version already present: merge in the new arch (or reject a duplicate arch).
  const result = await ctx.data.versions.patch<AddArchResult>({
    package: opts.package,
    version: opts.version,
    patch: (row) => {
      if (!row?.id || row.deletedAt) {
        return { result: { ok: false, reason: "version_gone" as const } };
      }
      const existing = parseLuarocksVersionMeta(row.metadata) ?? baseMeta;
      if (existing.blobs[opts.arch]) {
        return { result: { ok: false, reason: "arch_exists" as const } };
      }
      // A later rockspec upload refreshes the descriptive fields; otherwise keep
      // whatever was already recorded.
      const descriptive = opts.rockspecFields
        ? descriptiveMeta(opts.rockspecFields)
        : {
            ...(existing.summary ? { summary: existing.summary } : {}),
            ...(existing.homepage ? { homepage: existing.homepage } : {}),
            ...(existing.license ? { license: existing.license } : {}),
            ...(existing.dependencies ? { dependencies: existing.dependencies } : {}),
          };
      const merged: LuarocksVersionMeta = {
        rock: opts.rock,
        version: opts.version,
        ...descriptive,
        blobs: { ...existing.blobs, [opts.arch]: blobEntry },
      };
      return {
        update: { metadata: merged, sizeBytes: versionSizeBytes(merged) },
        result: { ok: true, versionId: row.id },
      };
    },
  });
  if (result.ok) await upsertArchAsset(ctx, { ...opts, versionId: result.versionId });
  return result;
}

function upsertArchAsset(
  ctx: RegistryRequestContext,
  opts: {
    package: RegistryPackageHandle;
    rock: string;
    version: string;
    arch: string;
    filename: string;
    stored: RegistryStoredBlob;
    sizeBytes: number;
    versionId: string;
  },
): Promise<unknown> {
  const scope = luarocksBlobScope(opts.rock, opts.version, opts.filename);
  return ctx.data.assets.upsert({
    digest: opts.stored.digest,
    blobRefId: opts.stored.blobRefId,
    role: LUAROCKS_BLOB_KIND,
    package: opts.package,
    packageVersion: { id: opts.versionId, packageId: opts.package.id, version: opts.version },
    scope,
    path: opts.filename,
    mediaType: "application/octet-stream",
    sizeBytes: opts.sizeBytes,
    metadata: { rock: opts.rock, version: opts.version, arch: opts.arch },
  });
}
