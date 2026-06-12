import {
  digestHex,
  type RegistryPackageHandle,
  type RegistryRequestContext,
  type RegistryStoredBlob,
  releaseRegistryBlobRef,
  storeRegistryBlobStreamWithRef,
} from "@hootifactory/registry";
import { type HomebrewPublishPlan, parseHomebrewPublishRequest } from "./homebrew-publish";
import {
  BOTTLE_ASSET_ROLE,
  BOTTLE_MEDIA_TYPE,
  bottleScope,
  type HomebrewBottleFile,
  type HomebrewVersionMeta,
  parseHomebrewVersionMeta,
  versionSizeBytes,
} from "./homebrew-validation";

export function buildHomebrewBottleMeta(digest: string, sizeBytes: number): HomebrewBottleFile {
  return { blobDigest: digest, sha256: digestHex(digest), sizeBytes };
}

type AddBottleResult =
  | { ok: true; versionId: string }
  | { ok: false; reason: "tag_exists" | "version_exists" };

export async function handleHomebrewPublish(
  nameRaw: string,
  versionRaw: string,
  tagRaw: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseHomebrewPublishRequest(nameRaw, versionRaw, tagRaw, req);
  if (!parsed.ok)
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  const { name, version, tag, bottle } = parsed.plan;
  const scope = bottleScope(name, version, tag);

  // A bottle file (formula+version+tag) is immutable: reject re-publish, even of
  // a tombstoned asset hidden by retention.
  if (
    await ctx.data.assets.findByScope({
      role: BOTTLE_ASSET_ROLE,
      scope,
      includeDeleted: true,
    })
  ) {
    return Response.json({ error: "bottle already exists" }, { status: 409 });
  }

  const stored = await storeRegistryBlobStreamWithRef(ctx, {
    data: bottle.stream(),
    kind: BOTTLE_ASSET_ROLE,
    scope,
    mediaType: BOTTLE_MEDIA_TYPE,
  });

  const pkg = await ctx.data.packages.findOrCreate({ name });
  const bottleMeta = buildHomebrewBottleMeta(stored.digest, bottle.size);

  const added = await addBottleToVersion(ctx, {
    package: pkg,
    version,
    tag,
    plan: parsed.plan,
    bottleMeta,
    stored,
    sizeBytes: bottle.size,
  });
  if (!added.ok) {
    if (stored.refCreated) {
      await releaseRegistryBlobRef(ctx, { digest: stored.digest, kind: BOTTLE_ASSET_ROLE, scope });
    }
    return Response.json({ error: "bottle already exists" }, { status: 409 });
  }

  return Response.json({ ok: true, name, version, tag }, { status: 201 });
}

function descriptiveMeta(
  plan: Pick<HomebrewPublishPlan, "info">,
): Pick<HomebrewVersionMeta, "desc" | "homepage" | "license" | "dependencies"> {
  const { desc, homepage, license, dependencies } = plan.info;
  return {
    ...(desc ? { desc } : {}),
    ...(homepage ? { homepage } : {}),
    ...(license ? { license } : {}),
    ...(dependencies ? { dependencies } : {}),
  };
}

async function addBottleToVersion(
  ctx: RegistryRequestContext,
  opts: {
    package: RegistryPackageHandle;
    version: string;
    tag: string;
    plan: HomebrewPublishPlan;
    bottleMeta: HomebrewBottleFile;
    stored: RegistryStoredBlob;
    sizeBytes: number;
  },
): Promise<AddBottleResult> {
  const metadata: HomebrewVersionMeta = {
    ...descriptiveMeta(opts.plan),
    bottles: { [opts.tag]: opts.bottleMeta },
  };
  const created = await ctx.data.versions.create({
    package: opts.package,
    version: opts.version,
    metadata,
    sizeBytes: versionSizeBytes(metadata),
  });
  if (created) {
    await upsertBottleAsset(ctx, { ...opts, versionId: created });
    return { ok: true, versionId: created };
  }

  // Version already present: patch in the new tag (or reject a duplicate tag).
  const result = await ctx.data.versions.patch<AddBottleResult>({
    package: opts.package,
    version: opts.version,
    patch: (row) => {
      if (!row?.id || row.deletedAt) {
        return { result: { ok: false, reason: "version_exists" as const } };
      }
      const existing = parseHomebrewVersionMeta(row.metadata) ?? { bottles: {} };
      if (existing.bottles[opts.tag]) {
        return { result: { ok: false, reason: "tag_exists" as const } };
      }
      const merged: HomebrewVersionMeta = {
        ...existing,
        ...descriptiveMeta(opts.plan),
        bottles: { ...existing.bottles, [opts.tag]: opts.bottleMeta },
      };
      // Recompute the version's total size from the merged bottle set so adding a
      // platform tag grows the version's accounted size rather than leaving it
      // stuck at the first bottle's bytes.
      return {
        update: { metadata: merged, sizeBytes: versionSizeBytes(merged) },
        result: { ok: true, versionId: row.id },
      };
    },
  });
  if (result.ok) await upsertBottleAsset(ctx, { ...opts, versionId: result.versionId });
  return result;
}

function upsertBottleAsset(
  ctx: RegistryRequestContext,
  opts: {
    package: RegistryPackageHandle;
    version: string;
    tag: string;
    stored: RegistryStoredBlob;
    sizeBytes: number;
    versionId: string;
  },
): Promise<unknown> {
  const scope = bottleScope(opts.package.name, opts.version, opts.tag);
  return ctx.data.assets.upsert({
    digest: opts.stored.digest,
    blobRefId: opts.stored.blobRefId,
    role: BOTTLE_ASSET_ROLE,
    package: opts.package,
    packageVersion: { id: opts.versionId, packageId: opts.package.id, version: opts.version },
    scope,
    path: scope,
    mediaType: BOTTLE_MEDIA_TYPE,
    sizeBytes: opts.sizeBytes,
    metadata: { tag: opts.tag },
    scanInput: {
      digest: opts.stored.digest,
      name: opts.package.name,
      version: opts.version,
      mediaType: BOTTLE_MEDIA_TYPE,
    },
  });
}
