import {
  digestHex,
  type RegistryPackageHandle,
  type RegistryRequestContext,
  type RegistryStoredBlob,
  releaseRegistryBlobRef,
  storeRegistryBlobStreamWithRef,
} from "@hootifactory/registry";
import { parseVagrantPublishRequest } from "./vagrant-publish";
import {
  BOX_ASSET_ROLE,
  BOX_MEDIA_TYPE,
  boxScope,
  parseVagrantVersionMeta,
  type VagrantProviderFile,
  type VagrantVersionMeta,
  versionSizeBytes,
} from "./vagrant-validation";

/** The logical box package name (`:user/:box`) used as the package key. */
export function boxName(user: string, box: string): string {
  return `${user}/${box}`;
}

export function buildVagrantProviderFile(digest: string, sizeBytes: number): VagrantProviderFile {
  return { blobDigest: digest, sha256: digestHex(digest), sizeBytes };
}

type AddProviderResult =
  | { ok: true; versionId: string }
  | { ok: false; reason: "provider_exists" | "version_exists" };

export async function handleVagrantPublish(
  userRaw: string,
  boxRaw: string,
  versionRaw: string,
  providerRaw: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = parseVagrantPublishRequest(userRaw, boxRaw, versionRaw, providerRaw, req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  const { user, box, version, provider, artifact } = parsed.plan;
  const name = boxName(user, box);
  const scope = boxScope(name, version, provider);

  // A (version, provider) box file is immutable: reject re-publish, even of a
  // tombstoned asset hidden by retention.
  if (
    await ctx.data.assets.findByScope({
      role: BOX_ASSET_ROLE,
      scope,
      includeDeleted: true,
    })
  ) {
    return Response.json({ error: "box provider already exists" }, { status: 409 });
  }

  // Stream the (potentially large) `.box` body straight into storage instead of
  // buffering it in memory.
  const stored = await storeRegistryBlobStreamWithRef(ctx, {
    data: artifact,
    kind: BOX_ASSET_ROLE,
    scope,
    mediaType: BOX_MEDIA_TYPE,
  });

  // An empty body is only knowable once the stream is drained: a box must carry
  // bytes, so reject it and undo any ref the empty store created.
  if (stored.size === 0) {
    if (stored.refCreated) {
      await releaseRegistryBlobRef(ctx, { digest: stored.digest, kind: BOX_ASSET_ROLE, scope });
    }
    return Response.json({ error: "empty box artifact" }, { status: 400 });
  }

  const pkg = await ctx.data.packages.findOrCreate({ name });
  const providerFile = buildVagrantProviderFile(stored.digest, stored.size);

  const added = await addProviderToVersion(ctx, {
    package: pkg,
    version,
    provider,
    providerFile,
    stored,
    sizeBytes: stored.size,
  });
  if (!added.ok) {
    if (stored.refCreated) {
      await releaseRegistryBlobRef(ctx, { digest: stored.digest, kind: BOX_ASSET_ROLE, scope });
    }
    return Response.json({ error: "box provider already exists" }, { status: 409 });
  }

  return Response.json({ ok: true, name, version, provider }, { status: 201 });
}

async function addProviderToVersion(
  ctx: RegistryRequestContext,
  opts: {
    package: RegistryPackageHandle;
    version: string;
    provider: string;
    providerFile: VagrantProviderFile;
    stored: RegistryStoredBlob;
    sizeBytes: number;
  },
): Promise<AddProviderResult> {
  const metadata: VagrantVersionMeta = {
    providers: { [opts.provider]: opts.providerFile },
  };
  const created = await ctx.data.versions.create({
    package: opts.package,
    version: opts.version,
    metadata,
    sizeBytes: versionSizeBytes(metadata),
  });
  if (created) {
    await upsertProviderAsset(ctx, { ...opts, versionId: created });
    return { ok: true, versionId: created };
  }

  // Version already present: patch in the new provider (or reject a duplicate).
  const result = await ctx.data.versions.patch<AddProviderResult>({
    package: opts.package,
    version: opts.version,
    patch: (row) => {
      if (!row?.id || row.deletedAt) {
        return { result: { ok: false, reason: "version_exists" as const } };
      }
      const existing = parseVagrantVersionMeta(row.metadata) ?? { providers: {} };
      if (existing.providers[opts.provider]) {
        return { result: { ok: false, reason: "provider_exists" as const } };
      }
      const merged: VagrantVersionMeta = {
        ...existing,
        providers: { ...existing.providers, [opts.provider]: opts.providerFile },
      };
      // Recompute the version's total size from the merged provider set so adding
      // a provider grows the version's accounted size rather than leaving it stuck
      // at the first provider's bytes.
      return {
        update: { metadata: merged, sizeBytes: versionSizeBytes(merged) },
        result: { ok: true, versionId: row.id },
      };
    },
  });
  if (result.ok) await upsertProviderAsset(ctx, { ...opts, versionId: result.versionId });
  return result;
}

function upsertProviderAsset(
  ctx: RegistryRequestContext,
  opts: {
    package: RegistryPackageHandle;
    version: string;
    provider: string;
    stored: RegistryStoredBlob;
    sizeBytes: number;
    versionId: string;
  },
): Promise<unknown> {
  const scope = boxScope(opts.package.name, opts.version, opts.provider);
  return ctx.data.assets.upsert({
    digest: opts.stored.digest,
    blobRefId: opts.stored.blobRefId,
    role: BOX_ASSET_ROLE,
    package: opts.package,
    packageVersion: { id: opts.versionId, packageId: opts.package.id, version: opts.version },
    scope,
    path: scope,
    mediaType: BOX_MEDIA_TYPE,
    sizeBytes: opts.sizeBytes,
    metadata: { provider: opts.provider },
    scanInput: {
      digest: opts.stored.digest,
      name: opts.package.name,
      version: opts.version,
      mediaType: BOX_MEDIA_TYPE,
    },
  });
}
