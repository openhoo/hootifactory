import {
  mapWithBoundedConcurrency,
  type RegistryRequestContext,
  safeFetch,
} from "@hootifactory/registry";
import {
  CONDA_MEDIA_TYPE,
  CONDA_PACKAGE_KIND,
  condaBlobScope,
  condaVersionKey,
} from "./conda-publish-lifecycle";
import {
  buildCondaVersionMeta,
  type CondaIndexJson,
  CondaIndexJsonSchema,
  type CondaPackageKind,
  condaPackageKind,
  isValidCondaSubdir,
  parseCondaFilename,
} from "./conda-validation";

const CONDA_PROXY_MIRROR_CONCURRENCY = 4;
/**
 * Upper bound on how many packages a single repodata refresh mirrors. A real
 * channel subdir (e.g. conda-forge `linux-64`) lists hundreds of thousands of
 * packages; without a cap one `repodata.json` fetch would try to download the
 * entire channel. The cap keeps a refresh bounded — subsequent refreshes pick
 * up packages not yet mirrored.
 */
const CONDA_PROXY_MAX_PACKAGES = 500;

/** Drop a trailing slash so we can join path segments predictably. */
function trimTrailingSlash(base: string): string {
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

/**
 * Mirror a subdir's `repodata.json` from `https://conda.anaconda.org/<channel>`.
 * `subdir` arrives as the proxy package name; `upstreamBase` is the configured
 * upstream channel URL. We fetch the upstream repodata, then download +
 * checksum-verify each referenced package and store it as an immutable version
 * so the local `repodata.json` regenerates with the mirrored entries.
 */
export async function handleCondaProxyIngest(
  subdir: string,
  upstreamBase: string,
  ctx: RegistryRequestContext,
): Promise<boolean> {
  if (!isValidCondaSubdir(subdir)) return false;
  let upstreamHost: string;
  try {
    upstreamHost = new URL(upstreamBase).host;
  } catch {
    return false;
  }

  const base = trimTrailingSlash(upstreamBase);
  const repodataUrl = `${base}/${subdir}/repodata.json`;
  const repodata = await fetchUpstreamRepodata(repodataUrl, upstreamHost, ctx);
  if (!repodata) return false;

  const entries: Array<{
    filename: string;
    kind: CondaPackageKind;
    record: Record<string, unknown>;
  }> = [];
  for (const [filename, record] of Object.entries(repodata.packages)) {
    const kind = condaPackageKind(filename);
    if (kind && isJsonObject(record)) entries.push({ filename, kind, record });
  }
  for (const [filename, record] of Object.entries(repodata.packagesConda)) {
    const kind = condaPackageKind(filename);
    if (kind && isJsonObject(record)) entries.push({ filename, kind, record });
  }
  if (entries.length === 0) return false;
  const bounded = entries.slice(0, CONDA_PROXY_MAX_PACKAGES);

  let mirrored = false;
  await mapWithBoundedConcurrency(bounded, CONDA_PROXY_MIRROR_CONCURRENCY, async (entry) => {
    const ok = await mirrorPackage({ subdir, base, upstreamHost, ...entry, ctx });
    if (ok) mirrored = true;
  });
  return mirrored;
}

interface UpstreamRepodata {
  packages: Record<string, unknown>;
  packagesConda: Record<string, unknown>;
}

async function fetchUpstreamRepodata(
  url: string,
  upstreamHost: string,
  ctx: RegistryRequestContext,
): Promise<UpstreamRepodata | null> {
  const res = await safeFetch(url, {
    allowedHosts: [upstreamHost],
    enforcePublicNetwork: ctx.limits.enforcePublicNetwork,
    headers: { accept: "application/json" },
  }).catch(() => null);
  if (!res?.ok) return null;
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > ctx.limits.maxUploadBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  if (!isJsonObject(json)) return null;
  const packages = isJsonObject(json.packages) ? json.packages : {};
  const packagesConda = isJsonObject(json["packages.conda"]) ? json["packages.conda"] : {};
  return { packages, packagesConda };
}

async function mirrorPackage(input: {
  subdir: string;
  base: string;
  upstreamHost: string;
  filename: string;
  kind: CondaPackageKind;
  record: Record<string, unknown>;
  ctx: RegistryRequestContext;
}): Promise<boolean> {
  const { subdir, base, upstreamHost, filename, kind, record, ctx } = input;
  const coords = parseCondaFilename(filename);
  if (!coords) return false;

  // Build the index.json from the upstream repodata record (it carries the same
  // fields). Fall back to the filename coordinates for name/version/build.
  const index = buildIndexFromRecord(record, coords);
  if (!index) return false;

  const versionKey = condaVersionKey(index.version, index.build, kind);
  const existing = await ctx.data.packages.findByName(index.name);
  if (existing && (await ctx.data.versions.exists(existing, versionKey))) return true;

  const declaredSha256 = typeof record.sha256 === "string" ? record.sha256 : null;
  const url = `${base}/${subdir}/${encodeURIComponent(filename)}`;
  const downloaded = await fetchPackage(url, upstreamHost, ctx);
  if (!downloaded) return false;
  const { bytes, sha256, md5 } = downloaded;
  // The upstream repodata is untrusted JSON: only store the blob if its bytes
  // hash to the sha256 the index advertised.
  if (declaredSha256 && declaredSha256 !== sha256) return false;

  const pkg = existing ?? (await ctx.data.packages.findOrCreate({ name: index.name }));
  const scope = condaBlobScope(subdir, filename);
  await ctx.data.versions.upsertWithBlobRef({
    package: pkg,
    version: versionKey,
    metadata: buildCondaVersionMeta(index, {
      subdir,
      filename,
      packageKind: kind,
      digest: `sha256:${sha256}`,
      sha256,
      md5,
      size: bytes.length,
    }),
    sizeBytes: bytes.length,
    blob: {
      data: bytes,
      kind: CONDA_PACKAGE_KIND,
      scope,
      mediaType: CONDA_MEDIA_TYPE,
      asset: {
        role: CONDA_PACKAGE_KIND,
        scope,
        path: scope,
        mediaType: CONDA_MEDIA_TYPE,
        metadata: {
          name: index.name,
          version: index.version,
          build: index.build,
          subdir,
          filename,
        },
      },
    },
  });
  await ctx.enqueueScan({
    digest: `sha256:${sha256}`,
    name: index.name,
    version: index.version,
    mediaType: CONDA_MEDIA_TYPE,
  });
  return true;
}

function buildIndexFromRecord(
  record: Record<string, unknown>,
  coords: { name: string; version: string; build: string },
): CondaIndexJson | null {
  const candidate: Record<string, unknown> = {
    name: typeof record.name === "string" ? record.name : coords.name,
    version: typeof record.version === "string" ? record.version : coords.version,
    build: typeof record.build === "string" ? record.build : coords.build,
  };
  for (const key of [
    "build_number",
    "depends",
    "constrains",
    "subdir",
    "license",
    "license_family",
    "timestamp",
    "track_features",
    "features",
    "noarch",
  ]) {
    if (record[key] !== undefined) candidate[key] = record[key];
  }
  const parsed = CondaIndexJsonSchema.safeParse(candidate);
  if (!parsed.success) return null;
  // The record must agree with the filename coordinates.
  if (
    parsed.data.name !== coords.name ||
    parsed.data.version !== coords.version ||
    parsed.data.build !== coords.build
  ) {
    return null;
  }
  return parsed.data;
}

async function fetchPackage(
  url: string,
  upstreamHost: string,
  ctx: RegistryRequestContext,
): Promise<{ bytes: Uint8Array; sha256: string; md5: string } | null> {
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
  const reader = res.body?.getReader();
  if (!reader) return null;
  const sha256 = new Bun.CryptoHasher("sha256");
  const md5 = new Bun.CryptoHasher("md5");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ctx.limits.maxUploadBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    sha256.update(value);
    md5.update(value);
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, sha256: sha256.digest("hex"), md5: md5.digest("hex") };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
