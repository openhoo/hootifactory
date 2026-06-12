import {
  computeDigest,
  inheritUrlCredentials,
  mapWithBoundedConcurrency,
  type RegistryRequestContext,
  safeFetch,
  safeJsonParse,
} from "@hootifactory/registry";
import {
  type ChefUpstreamCookbookMeta,
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
      // Same-host version/tarball fetches reuse the upstream base's credentials
      // (stored metadata keeps the original upstream URLs).
      const detail = parseChefUpstreamVersion(
        await fetchJson(inheritUrlCredentials(versionUrl, upstreamBase), upstreamHost, ctx),
      );
      if (!detail) return;
      if (existingVersions.has(detail.version)) return;

      const tarball = await fetchTarball(
        inheritUrlCredentials(detail.file, upstreamBase),
        upstreamHost,
        ctx,
      );
      if (!tarball) return;

      pkg ??= await ctx.data.packages.findOrCreate({ name: cookbookName });
      const scope = chefBlobScope(cookbookName, detail.version);
      // Storage hashes with sha256, so the locally computed digest is exactly the
      // digest the stored blob ref resolves against in the download route.
      const digest = computeDigest(tarball);
      const { stored } = await ctx.data.versions.upsertWithBlobRef({
        package: pkg,
        version: detail.version,
        metadata: buildUpstreamVersionMeta(detail, parsed, digest),
        sizeBytes: tarball.length,
        scan: {
          name: cookbookName,
          version: detail.version,
          mediaType: TARBALL_MEDIA_TYPE,
        },
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
    },
  );

  return Boolean(pkg);
}

/**
 * Build the stored metadata for a mirrored upstream version against its digest.
 * Threads the cookbook-level descriptive fields (maintainer/category/source/issues)
 * and preserves the upstream release time so a mirrored listing reproduces the
 * upstream metadata instead of empty placeholders + local ingest timestamps.
 */
function buildUpstreamVersionMeta(
  detail: ChefUpstreamVersion,
  cookbook: ChefUpstreamCookbookMeta,
  digest: string,
) {
  return buildChefVersionMeta(
    {
      version: detail.version,
      description: detail.description,
      license: detail.license,
      maintainer: cookbook.maintainer,
      category: cookbook.category,
      source_url: cookbook.source_url,
      issues_url: cookbook.issues_url,
      dependencies: detail.dependencies,
    },
    { digest },
    { published: detail.published },
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
  const bytes = await readCappedBody(res, MAX_JSON_BYTES);
  if (!bytes) return null;
  const parsed = safeJsonParse(new TextDecoder().decode(bytes));
  return parsed.success ? parsed.data : null;
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
  const bytes = await readCappedBody(res, ctx.limits.maxUploadBytes);
  if (!bytes || bytes.length === 0) return null;
  return bytes;
}

/**
 * Read an upstream response body, capped at `maxBytes`, streaming so an upstream
 * cannot exhaust memory by omitting/understating `Content-Length`. Rejects (and
 * cancels the body) as soon as the declared length or streamed total exceeds the
 * cap. Returns null on overflow so callers skip the offending resource.
 */
async function readCappedBody(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
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
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
