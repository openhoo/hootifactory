import { type RegistryRequestContext, safeFetch } from "@hootifactory/registry";
import { responseJson } from "./npm-http";
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
  const versionEntries = Object.entries(packument.versions ?? {}).filter(([version]) =>
    isValidNpmVersion(version),
  );

  await runWithConcurrency(
    versionEntries,
    NPM_PROXY_MIRROR_CONCURRENCY,
    async ([version, manifestRaw]) => {
      const proxyManifest = normalizeNpmProxyManifest(pkgName, version, manifestRaw);
      if (!proxyManifest) return;

      let { manifest } = proxyManifest;
      const { tarballUrl, upstreamDist } = proxyManifest;
      const existingVersion = pkg ? await ctx.data.versions.findLive(pkg, version) : null;
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
      await ctx.enqueueScan({
        digest: stored.digest,
        name: pkgName,
        version,
        mediaType: "application/octet-stream",
      });
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
  upstreamDist: Parameters<typeof upstreamDistMatchesDigests>[0];
  ctx: RegistryRequestContext;
}): Promise<{ tarball: Uint8Array; digests: NpmTarballDigests } | null> {
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
  const result = await responseBytesWithDigests(response, input.ctx.limits.maxUploadBytes);
  if (!result) return null;
  return upstreamDistMatchesDigests(input.upstreamDist, result.digests, result.tarball)
    ? result
    : null;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const item = items[next++];
        if (item !== undefined) await run(item);
      }
    }),
  );
}

async function responseBytesWithDigests(
  res: Response,
  maxBytes: number,
): Promise<{ tarball: Uint8Array; digests: NpmTarballDigests } | null> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  const reader = res.body?.getReader();
  if (!reader) {
    return {
      tarball: new Uint8Array(0),
      digests: {
        blobDigest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        shasum: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
        integrity:
          "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==",
      },
    };
  }

  const sha256 = new Bun.CryptoHasher("sha256");
  const sha1 = new Bun.CryptoHasher("sha1");
  const sha512 = new Bun.CryptoHasher("sha512");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    sha256.update(value);
    sha1.update(value);
    sha512.update(value);
    chunks.push(value);
  }

  const tarball = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    tarball.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    tarball,
    digests: {
      blobDigest: `sha256:${sha256.digest("hex")}`,
      shasum: sha1.digest("hex"),
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
