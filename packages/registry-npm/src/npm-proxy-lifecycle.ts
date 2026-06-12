import {
  inheritUrlCredentials,
  mapWithBoundedConcurrency,
  type RegistryRequestContext,
  readBoundedBytes,
  safeJsonParse,
  upstreamFetch,
} from "@hootifactory/registry";
import {
  type NpmTarballDigests,
  upstreamDistMatchesDigests,
  upstreamDistMatchesStored,
} from "./npm-integrity";
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

const NPM_PROXY_MIRROR_CONCURRENCY = 4;

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
  let packagePromise: Promise<NonNullable<typeof pkg>> | null = null;
  const ensurePackage = async () => {
    if (pkg) return pkg;
    packagePromise ??= ctx.data.packages.findOrCreate({
      name: pkgName,
      namespace: scope,
    });
    pkg = await packagePromise;
    return pkg;
  };
  const ingestedVersions = new Map<string, { id: string; packageId: string; version: string }>();
  const liveByVersion = new Map(
    pkg ? (await ctx.data.versions.listLive(pkg)).map((row) => [row.version, row]) : [],
  );
  const versionEntries = Object.entries(packument.versions ?? {}).filter(([version]) =>
    isValidNpmVersion(version),
  );

  await mapWithBoundedConcurrency(
    versionEntries,
    NPM_PROXY_MIRROR_CONCURRENCY,
    async ([version, manifestRaw]) => {
      const proxyManifest = normalizeNpmProxyManifest(pkgName, version, manifestRaw);
      if (!proxyManifest) return;

      let { manifest } = proxyManifest;
      const { tarballUrl, upstreamDist } = proxyManifest;
      const existingVersion = liveByVersion.get(version) ?? null;
      const existingMetadata = existingVersion
        ? parseNpmStoredVersionMetadata(existingVersion.metadata)
        : null;
      const existingDist = existingMetadata?.dist;

      if (
        pkg &&
        existingVersion &&
        existingDist &&
        upstreamDistMatchesStored(upstreamDist, existingDist)
      ) {
        manifest = rewriteNpmProxyManifestForExistingDist({
          manifest,
          upstreamDist,
          existingDist,
          baseUrl: ctx.baseUrl,
          mountPath: ctx.repo.mountPath,
          packageName: pkgName,
        });
        if (JSON.stringify(existingMetadata.manifest) === JSON.stringify(manifest)) {
          ingestedVersions.set(version, {
            id: existingVersion.id,
            packageId: existingVersion.packageId,
            version,
          });
          return;
        }
        const versionId = await ctx.data.versions.upsert({
          package: pkg,
          version,
          metadata: { manifest, dist: existingDist },
          sizeBytes: existingDist.size,
        });
        ingestedVersions.set(version, { id: versionId, packageId: pkg.id, version });
        return;
      }

      const verified = await fetchVerifiedNpmTarball({
        tarballUrl,
        upstreamBase,
        upstreamHost,
        upstreamDist,
        ctx,
      });
      if (!verified) return;
      const { digests, tarball } = verified;

      const targetPkg = await ensurePackage();
      const previousDigest = existingDist?.blobDigest;
      const { manifestDist, dist } = buildNpmMirroredDist({
        packageName: pkgName,
        version,
        upstreamDist,
        tarball,
        digests,
        baseUrl: ctx.baseUrl,
        mountPath: ctx.repo.mountPath,
      });
      manifest.dist = manifestDist;
      const { stored, versionId } = await ctx.data.versions.upsertWithBlobRef({
        package: targetPkg,
        version,
        metadata: { manifest, dist },
        sizeBytes: tarball.length,
        scan: {
          name: pkgName,
          version,
          mediaType: "application/octet-stream",
        },
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
      ingestedVersions.set(version, { id: versionId, packageId: targetPkg.id, version });
    },
  );

  if (!pkg) return false;
  await ctx.data.tags.replace(
    pkg,
    resolveNpmProxyDistTags(packument["dist-tags"] ?? {}, ingestedVersions),
  );
  return true;
}

async function fetchNpmUpstreamPackument(
  upstreamBase: string,
  packageName: string,
  ctx: RegistryRequestContext,
) {
  const url = npmUpstreamPackumentUrl(upstreamBase, packageName);
  const upstreamHost = npmUpstreamHost(upstreamBase);
  if (!upstreamHost) return null;
  const res = await upstreamFetch(ctx, url, {
    pinHost: upstreamHost,
    headers: { accept: "application/json" },
  });
  if (!res?.ok) return null;
  const read = await readBoundedBytes(res, Math.min(ctx.limits.maxUploadBytes, 10 * 1024 * 1024));
  if (!read) return null;
  const decoded = safeJsonParse(new TextDecoder().decode(read.bytes));
  return parseNpmUpstreamPackument(decoded.success ? decoded.data : null);
}

async function fetchVerifiedNpmTarball(input: {
  tarballUrl: string;
  upstreamBase: string;
  upstreamHost: string;
  upstreamDist: Parameters<typeof upstreamDistMatchesDigests>[0];
  ctx: RegistryRequestContext;
}): Promise<{ tarball: Uint8Array; digests: NpmTarballDigests } | null> {
  // Upstream packument JSON is untrusted; tarballs must stay on the configured host.
  if (!isNpmTarballUrlOnUpstreamHost(input.tarballUrl, input.upstreamHost)) return null;
  // Same-host tarball fetches reuse the upstream base's credentials (the
  // stored metadata keeps the original, credential-free upstream URL).
  const response = await upstreamFetch(
    input.ctx,
    inheritUrlCredentials(input.tarballUrl, input.upstreamBase),
    {
      pinHost: input.upstreamHost,
    },
  );
  if (!response?.ok) return null;
  const result = await responseBytesWithDigests(response, input.ctx.limits.maxUploadBytes);
  if (!result) return null;
  return upstreamDistMatchesDigests(input.upstreamDist, result.digests, result.tarball)
    ? result
    : null;
}

async function responseBytesWithDigests(
  res: Response,
  maxBytes: number,
): Promise<{ tarball: Uint8Array; digests: NpmTarballDigests } | null> {
  const read = await readBoundedBytes(res, maxBytes, { digests: ["sha1", "sha256"] });
  const blobDigest = read?.digests.sha256;
  const shasum = read?.digests.sha1;
  if (!read || !blobDigest || !shasum) return null;
  const sha512 = new Bun.CryptoHasher("sha512");
  sha512.update(read.bytes);
  return {
    tarball: read.bytes,
    digests: {
      blobDigest,
      shasum,
      integrity: `sha512-${sha512.digest("base64")}`,
    },
  };
}

export function resolveNpmProxyDistTags(
  distTags: Record<string, string>,
  versionsByName: ReadonlyMap<string, { id: string; packageId: string; version: string }>,
): Map<string, { id: string; packageId: string; version: string }> {
  const desiredTags = new Map<string, { id: string; packageId: string; version: string }>();
  for (const [tag, version] of Object.entries(distTags)) {
    if (!isValidDistTag(tag) || typeof version !== "string") continue;
    const row = versionsByName.get(version);
    if (row) desiredTags.set(tag, row);
  }
  return desiredTags;
}
