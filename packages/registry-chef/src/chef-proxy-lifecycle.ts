import {
  computeDigest,
  mapWithBoundedConcurrency,
  type RegistryRequestContext,
  safeFetch,
} from "@hootifactory/registry";
import {
  type ChefUpstreamVersion,
  chefUpstreamCookbookUrl,
  chefUpstreamHost,
  isChefUrlOnUpstreamHost,
  parseChefUpstreamCookbook,
  parseChefUpstreamVersion,
} from "./chef-proxy";
import { chefBlobScope } from "./chef-publish-lifecycle";
import { buildChefVersionMeta } from "./chef-validation";

const CHEF_PROXY_MIRROR_CONCURRENCY = 4;
const TARBALL_MEDIA_TYPE = "application/gzip";
const MAX_JSON_BYTES = 4 * 1024 * 1024;

/**
 * Pull-through: mirror an upstream Supermarket cookbook (all versions) into this
 * proxy repo's CAS. Returns true when at least the cookbook listing was fetched
 * and the package row exists so a local read can now succeed.
 */
export async function handleChefProxyIngest(
  cookbookName: string,
  upstreamBase: string,
  ctx: RegistryRequestContext,
): Promise<boolean> {
  const upstreamHost = chefUpstreamHost(upstreamBase);
  if (!upstreamHost) return false;

  const cookbook = await fetchJson(
    chefUpstreamCookbookUrl(upstreamBase, cookbookName),
    upstreamHost,
    ctx,
  );
  const parsed = parseChefUpstreamCookbook(cookbook);
  if (!parsed || parsed.name !== cookbookName) return false;

  let pkg = await ctx.data.packages.findByName(cookbookName);
  const existingVersions = new Set(
    pkg ? (await ctx.data.versions.listLive(pkg)).map((row) => row.version) : [],
  );

  await mapWithBoundedConcurrency(
    parsed.versions,
    CHEF_PROXY_MIRROR_CONCURRENCY,
    async (versionUrl) => {
      if (!isChefUrlOnUpstreamHost(versionUrl, upstreamHost)) return;
      const detail = parseChefUpstreamVersion(await fetchJson(versionUrl, upstreamHost, ctx));
      if (!detail) return;
      if (existingVersions.has(detail.version)) return;

      const tarball = await fetchTarball(detail.file, upstreamHost, ctx);
      if (!tarball) return;

      pkg ??= await ctx.data.packages.findOrCreate({ name: cookbookName });
      const scope = chefBlobScope(cookbookName, detail.version);
      // Storage hashes with sha256, so the locally computed digest is exactly the
      // digest the stored blob ref resolves against in the download route.
      const digest = computeDigest(tarball);
      const { stored } = await ctx.data.versions.upsertWithBlobRef({
        package: pkg,
        version: detail.version,
        metadata: buildUpstreamVersionMeta(detail, digest),
        sizeBytes: tarball.length,
        blob: {
          data: tarball,
          kind: "chef_cookbook",
          scope,
          mediaType: TARBALL_MEDIA_TYPE,
          asset: {
            role: "chef_cookbook",
            scope,
            path: `${cookbookName}-${detail.version}.tar.gz`,
            mediaType: TARBALL_MEDIA_TYPE,
            metadata: { cookbook: cookbookName, version: detail.version, upstream: detail.file },
          },
        },
      });
      if (stored.digest !== digest) throw new Error("stored chef tarball digest mismatch");
      await ctx.enqueueScan({
        digest: stored.digest,
        name: cookbookName,
        version: detail.version,
        mediaType: TARBALL_MEDIA_TYPE,
      });
    },
  );

  return Boolean(pkg);
}

/** Build the stored metadata for a mirrored upstream version against its digest. */
function buildUpstreamVersionMeta(detail: ChefUpstreamVersion, digest: string) {
  return buildChefVersionMeta(
    {
      version: detail.version,
      description: detail.description,
      license: detail.license,
      dependencies: detail.dependencies,
    },
    { digest },
  );
}

async function fetchJson(
  url: string,
  upstreamHost: string,
  ctx: RegistryRequestContext,
): Promise<unknown> {
  if (!isChefUrlOnUpstreamHost(url, upstreamHost)) return null;
  const res = await safeFetch(url, {
    allowedHosts: [upstreamHost],
    enforcePublicNetwork: ctx.limits.enforcePublicNetwork,
    headers: { accept: "application/json" },
  }).catch(() => null);
  if (!res?.ok) return null;
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_JSON_BYTES) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  return res.json().catch(() => null);
}

async function fetchTarball(
  url: string,
  upstreamHost: string,
  ctx: RegistryRequestContext,
): Promise<Uint8Array | null> {
  if (!isChefUrlOnUpstreamHost(url, upstreamHost)) return null;
  const res = await safeFetch(url, {
    allowedHosts: [upstreamHost],
    enforcePublicNetwork: ctx.limits.enforcePublicNetwork,
  }).catch(() => null);
  if (!res?.ok) return null;
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > ctx.limits.maxUploadBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > ctx.limits.maxUploadBytes) return null;
  return bytes;
}
