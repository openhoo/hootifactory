import {
  mapWithBoundedConcurrency,
  type RegistryPackageHandle,
  type RegistryRequestContext,
  safeFetch,
} from "@hootifactory/registry";
import {
  isPuppetFileUrlOnUpstreamHost,
  type PuppetUpstreamRelease,
  parsePuppetUpstreamModule,
  puppetUpstreamHost,
  puppetUpstreamModuleUrl,
  resolvePuppetFileUrl,
} from "./puppet-proxy";
import { puppetBlobScope } from "./puppet-publish";
import {
  isValidPuppetVersion,
  type PuppetReleaseMeta,
  parsePuppetMetadata,
  puppetReleaseFileName,
} from "./puppet-validation";

const PUPPET_PROXY_MIRROR_CONCURRENCY = 4;
const ARCHIVE_MEDIA_TYPE = "application/gzip";
const MAX_MODULE_JSON_BYTES = 8 * 1024 * 1024;

/**
 * Pull-through: mirror an upstream Forge module (all releases that advertise a
 * verifiable file + metadata) into this proxy repo's CAS. `slug` is the module
 * slug `<owner>-<name>` from the request path.
 */
export async function handlePuppetProxyIngest(
  slug: string,
  upstreamBase: string,
  ctx: RegistryRequestContext,
): Promise<boolean> {
  const upstreamHost = puppetUpstreamHost(upstreamBase);
  if (!upstreamHost) return false;
  const module = await fetchPuppetUpstreamModule(upstreamBase, slug, ctx);
  if (!module || module.slug !== slug) return false;

  let pkg: RegistryPackageHandle | null = await ctx.data.packages.findByName(slug);
  let packagePromise: Promise<RegistryPackageHandle> | null = null;
  const ensurePackage = async (): Promise<RegistryPackageHandle> => {
    const existing = pkg;
    if (existing) return existing;
    packagePromise ??= ctx.data.packages.findOrCreate({ name: slug, namespace: module.owner });
    const created = await packagePromise;
    pkg = created;
    return created;
  };

  const liveVersions = new Set(
    pkg ? (await ctx.data.versions.listLive(pkg)).map((row) => row.version) : [],
  );

  const releases = module.releases.filter((release) => isValidPuppetVersion(release.version));

  await mapWithBoundedConcurrency(releases, PUPPET_PROXY_MIRROR_CONCURRENCY, async (release) => {
    // Skip versions we already hold — Forge releases are immutable.
    if (liveVersions.has(release.version)) return;
    const verified = await fetchVerifiedPuppetRelease({
      upstreamBase,
      upstreamHost,
      release,
      ctx,
    });
    if (!verified) return;
    const { tarball, sha256 } = verified;
    const metadata = parsePuppetMetadata(release.metadata);
    if (!metadata || metadata.version !== release.version) return;

    const targetPkg = await ensurePackage();
    const scope = puppetBlobScope(slug, release.version);
    const meta: PuppetReleaseMeta = {
      version: release.version,
      metadata,
      blobDigest: `sha256:${sha256}`,
      fileSha256: sha256,
      fileMd5: md5Hex(tarball),
      fileSize: tarball.length,
      published: new Date().toISOString(),
    };
    const { stored } = await ctx.data.versions.upsertWithBlobRef({
      package: targetPkg,
      version: release.version,
      metadata: { ...meta },
      sizeBytes: tarball.length,
      blob: {
        data: tarball,
        kind: "puppet_release",
        scope,
        mediaType: ARCHIVE_MEDIA_TYPE,
        asset: {
          role: "puppet_release",
          scope,
          path: puppetReleaseFileName(module.owner, module.name, release.version),
          mediaType: ARCHIVE_MEDIA_TYPE,
          metadata: { module: slug, owner: module.owner },
        },
      },
    });
    if (stored.digest !== meta.blobDigest) {
      throw new Error("stored puppet release digest mismatch");
    }
    await ctx.enqueueScan({
      digest: stored.digest,
      name: slug,
      version: release.version,
      mediaType: ARCHIVE_MEDIA_TYPE,
    });
  });

  return Boolean(pkg);
}

function md5Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(bytes);
  return hasher.digest("hex");
}

async function fetchPuppetUpstreamModule(
  upstreamBase: string,
  slug: string,
  ctx: RegistryRequestContext,
) {
  const url = puppetUpstreamModuleUrl(upstreamBase, slug);
  // safeFetch rejects private/loopback/metadata hosts and re-validates redirects.
  const res = await safeFetch(url, {
    enforcePublicNetwork: ctx.limits.enforcePublicNetwork,
    headers: { accept: "application/json" },
  }).catch(() => null);
  if (!res?.ok) return null;
  const json = await readJson(res, MAX_MODULE_JSON_BYTES);
  return json ? parsePuppetUpstreamModule(json) : null;
}

async function readJson(res: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const text = await res.text().catch(() => null);
  if (text === null || text.length > maxBytes) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Download a release tarball from the upstream-advertised `file_uri` (kept on the
 * configured upstream host) and verify it matches the advertised `file_sha256`.
 * Upstream JSON is untrusted, so a release without a verifiable sha256 is skipped.
 */
async function fetchVerifiedPuppetRelease(input: {
  upstreamBase: string;
  upstreamHost: string;
  release: PuppetUpstreamRelease;
  ctx: RegistryRequestContext;
}): Promise<{ tarball: Uint8Array; sha256: string } | null> {
  const { upstreamBase, upstreamHost, release, ctx } = input;
  if (!release.file_uri || !release.file_sha256) return null;
  const fileUrl = resolvePuppetFileUrl(upstreamBase, release.file_uri);
  if (!fileUrl || !isPuppetFileUrlOnUpstreamHost(fileUrl, upstreamHost)) return null;

  let response: Response | null = null;
  try {
    response = await safeFetch(fileUrl, {
      allowedHosts: [upstreamHost],
      enforcePublicNetwork: ctx.limits.enforcePublicNetwork,
    });
  } catch {
    return null;
  }
  if (!response?.ok) return null;
  const tarball = await readBytes(response, ctx.limits.maxUploadBytes);
  if (!tarball) return null;
  const sha256 = sha256Hex(tarball);
  return sha256 === release.file_sha256 ? { tarball, sha256 } : null;
}

function sha256Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

async function readBytes(res: Response, maxBytes: number): Promise<Uint8Array | null> {
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
