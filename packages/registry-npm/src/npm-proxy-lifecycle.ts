import { type RegistryRequestContext, safeFetch } from "@hootifactory/registry";
import { responseBytes, responseJson } from "./npm-http";
import { upstreamDistMatchesBytes, upstreamDistMatchesStored } from "./npm-integrity";
import {
  buildNpmMirroredDist,
  isNpmTarballUrlOnUpstreamHost,
  normalizeNpmProxyManifest,
  npmUpstreamHost,
  npmUpstreamPackumentUrl,
  parseNpmUpstreamPackument,
  rewriteNpmProxyManifestForExistingDist,
} from "./npm-proxy";
import {
  isValidDistTag,
  isValidLegacyNpmName,
  isValidNpmVersion,
  parseNpmStoredVersionMetadata,
} from "./npm-validation";

export async function handleNpmProxyIngest(
  pkgName: string,
  upstreamBase: string,
  ctx: RegistryRequestContext,
): Promise<boolean> {
  if (!isValidLegacyNpmName(pkgName)) return false;
  const upstreamHost = npmUpstreamHost(upstreamBase);
  if (!upstreamHost) return false;
  const packument = await fetchNpmUpstreamPackument(upstreamBase, pkgName, ctx);
  if (!packument) return false;

  const scope = pkgName.startsWith("@") ? (pkgName.split("/")[0] ?? null) : null;
  let pkg = await ctx.data.packages.findByName(pkgName);
  for (const [version, manifestRaw] of Object.entries(packument.versions ?? {})) {
    if (!isValidNpmVersion(version)) continue;
    const proxyManifest = normalizeNpmProxyManifest(pkgName, version, manifestRaw);
    if (!proxyManifest) continue;

    let { manifest } = proxyManifest;
    const { tarballUrl, upstreamDist } = proxyManifest;
    const existingVersion = pkg ? await ctx.data.versions.findLive(pkg.id, version) : null;
    const existingDist = existingVersion
      ? parseNpmStoredVersionMetadata(existingVersion.metadata).dist
      : undefined;

    if (pkg && existingDist && upstreamDistMatchesStored(upstreamDist, existingDist)) {
      manifest = rewriteNpmProxyManifestForExistingDist({
        manifest,
        upstreamDist,
        existingDist,
        baseUrl: ctx.baseUrl,
        mountPath: ctx.repo.mountPath,
        packageName: pkgName,
      });
      await ctx.data.versions.upsert({
        packageId: pkg.id,
        version,
        metadata: { manifest, dist: existingDist },
        sizeBytes: existingDist.size,
      });
      continue;
    }

    const tarball = await fetchVerifiedNpmTarball({
      tarballUrl,
      upstreamHost,
      upstreamDist,
      ctx,
    });
    if (!tarball) continue;

    pkg ??= await ctx.data.packages.findOrCreate({
      name: pkgName,
      namespace: scope,
    });
    const previousDigest = existingDist?.blobDigest;
    const { manifestDist, dist } = buildNpmMirroredDist({
      packageName: pkgName,
      version,
      upstreamDist,
      tarball,
      baseUrl: ctx.baseUrl,
      mountPath: ctx.repo.mountPath,
    });
    manifest.dist = manifestDist;
    const { stored } = await ctx.data.versions.upsertWithBlobRef({
      packageId: pkg.id,
      version,
      metadata: { manifest, dist },
      sizeBytes: tarball.length,
      blob: {
        data: tarball,
        kind: "npm_tarball",
        scope: `${pkgName}@${version}`,
        mediaType: "application/octet-stream",
        previousDigest,
        asset: {
          role: "npm_tarball",
          scope: `${pkgName}@${version}`,
          path: dist.filename,
          mediaType: "application/octet-stream",
          metadata: {
            shasum: dist.shasum,
            integrity: dist.integrity,
            upstreamTarball: tarballUrl,
          },
        },
      },
    });
    if (stored.digest !== dist.blobDigest) throw new Error("stored npm tarball digest mismatch");
    await ctx.enqueueScan({
      digest: stored.digest,
      name: pkgName,
      version,
      mediaType: "application/octet-stream",
    });
  }

  if (!pkg) return false;
  await ctx.data.tags.replace(
    pkg.id,
    await resolveNpmProxyDistTags(packument["dist-tags"] ?? {}, (version) =>
      findVersionId(ctx, pkg.id, version),
    ),
  );
  return true;
}

async function fetchNpmUpstreamPackument(
  upstreamBase: string,
  packageName: string,
  ctx: RegistryRequestContext,
) {
  const url = npmUpstreamPackumentUrl(upstreamBase, packageName);
  // safeFetch rejects private/loopback/metadata hosts and re-validates redirects.
  const res = await safeFetch(url, {
    enforcePublicNetwork: ctx.limits.enforcePublicNetwork,
    headers: { accept: "application/json" },
  }).catch(() => null);
  if (!res?.ok) return null;
  return parseNpmUpstreamPackument(
    await responseJson(res, Math.min(ctx.limits.maxUploadBytes, 10 * 1024 * 1024)),
  );
}

async function fetchVerifiedNpmTarball(input: {
  tarballUrl: string;
  upstreamHost: string;
  upstreamDist: Parameters<typeof upstreamDistMatchesBytes>[0];
  ctx: RegistryRequestContext;
}): Promise<Uint8Array | null> {
  let response: Response | null = null;
  try {
    // Upstream packument JSON is untrusted; tarballs must stay on the configured host.
    if (!isNpmTarballUrlOnUpstreamHost(input.tarballUrl, input.upstreamHost)) return null;
    response = await safeFetch(input.tarballUrl, {
      allowedHosts: [input.upstreamHost],
      enforcePublicNetwork: input.ctx.limits.enforcePublicNetwork,
    });
  } catch {
    return null;
  }
  if (!response?.ok) return null;
  const tarball = await responseBytes(response, input.ctx.limits.maxUploadBytes);
  if (!tarball) return null;
  return upstreamDistMatchesBytes(input.upstreamDist, tarball) ? tarball : null;
}

export async function resolveNpmProxyDistTags(
  distTags: Record<string, string>,
  resolveVersionId: (version: string) => Promise<string | null>,
): Promise<Map<string, { version: string; versionId: string }>> {
  const desiredTags = new Map<string, { version: string; versionId: string }>();
  for (const [tag, version] of Object.entries(distTags)) {
    if (!isValidDistTag(tag) || typeof version !== "string") continue;
    const versionId = await resolveVersionId(version);
    if (versionId) desiredTags.set(tag, { version, versionId });
  }
  return desiredTags;
}

async function findVersionId(
  ctx: RegistryRequestContext,
  packageId: string,
  version: string,
): Promise<string | null> {
  return (await ctx.data.versions.findLive(packageId, version))?.id ?? null;
}
