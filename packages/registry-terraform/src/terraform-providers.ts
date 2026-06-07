import {
  type RegistryRequestContext,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { parseTerraformProviderPublishRequest } from "./terraform-publish";
import {
  parseTerraformProviderVersionMeta,
  type TerraformProviderDownloadDoc,
  type TerraformProviderPlatform,
  type TerraformProviderVersionMeta,
} from "./terraform-validation";

export const PROVIDER_ZIP_KIND = "terraform_provider";
export const PROVIDER_SHASUMS_KIND = "terraform_provider_shasums";

/** Package name a provider is stored under: `provider/<namespace>/<type>`. */
export function providerPackageName(namespace: string, type: string): string {
  return `provider/${namespace}/${type}`;
}

/** Blob-ref scope for one published provider platform zip. */
export function providerZipScope(
  namespace: string,
  type: string,
  version: string,
  os: string,
  arch: string,
): string {
  return `${namespace}/${type}@${version}/${os}_${arch}`;
}

/** Blob-ref scope for a provider version's SHASUMS (or its signature) file. */
export function providerShasumsScope(
  namespace: string,
  type: string,
  version: string,
  suffix: string,
): string {
  return `${namespace}/${type}@${version}/${suffix}`;
}

async function liveProviderMetas(
  ctx: RegistryRequestContext,
  pkg: { id: string; orgId: string; repositoryId: string; name: string },
): Promise<TerraformProviderVersionMeta[]> {
  const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" });
  return rows.flatMap((row) => {
    const meta = parseTerraformProviderVersionMeta(row.metadata);
    return meta ? [meta] : [];
  });
}

/**
 * `GET /v1/providers/:namespace/:type/versions` —
 * `{ versions: [{ version, protocols, platforms: [{ os, arch }] }] }`.
 */
export async function listProviderVersions(
  namespace: string,
  type: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const pkg = await ctx.data.packages.findByName(providerPackageName(namespace, type));
  if (!pkg) return new Response("Not Found", { status: 404 });
  const metas = await liveProviderMetas(ctx, pkg);
  if (metas.length === 0) return new Response("Not Found", { status: 404 });
  const body = {
    versions: metas.map((meta) => ({
      version: meta.version,
      protocols: meta.protocols,
      platforms: meta.platforms.map((platform) => ({ os: platform.os, arch: platform.arch })),
    })),
  };
  return textResponseWithEtag(req, JSON.stringify(body), {
    "content-type": "application/json; charset=utf-8",
  });
}

/**
 * `GET /v1/providers/:namespace/:type/:version/download/:os/:arch` — the JSON
 * download descriptor (download_url, shasums_url, shasum, protocols, …).
 */
export async function providerDownloadInfo(
  namespace: string,
  type: string,
  version: string,
  os: string,
  arch: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const meta = await findLiveProvider(ctx, namespace, type, version);
  if (!meta) return new Response("Not Found", { status: 404 });
  const platform = meta.platforms.find((p) => p.os === os && p.arch === arch);
  if (!platform) return new Response("Not Found", { status: 404 });

  const base = `${ctx.baseUrl}/${ctx.repo.mountPath}/v1/providers/${encodeURIComponent(
    namespace,
  )}/${encodeURIComponent(type)}/${encodeURIComponent(version)}`;
  const doc: TerraformProviderDownloadDoc = {
    protocols: meta.protocols,
    os: platform.os,
    arch: platform.arch,
    filename: platform.filename,
    download_url: `${base}/download/${encodeURIComponent(os)}/${encodeURIComponent(arch)}/zip`,
    shasums_url: `${base}/shasums`,
    shasum: platform.shasum,
  };
  if (meta.shasumsSignatureDigest) doc.shasums_signature_url = `${base}/shasums.sig`;
  if (meta.signingKeys && meta.signingKeys.length > 0) {
    doc.signing_keys = {
      gpg_public_keys: meta.signingKeys.map((key) => ({
        key_id: key.keyId,
        ascii_armor: key.asciiArmor,
      })),
    };
  }
  return textResponseWithEtag(req, JSON.stringify(doc), {
    "content-type": "application/json; charset=utf-8",
  });
}

/** `GET /v1/providers/:namespace/:type/:version/download/:os/:arch/zip` — serve the plugin zip. */
export async function serveProviderZip(
  namespace: string,
  type: string,
  version: string,
  os: string,
  arch: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const meta = await findLiveProvider(ctx, namespace, type, version);
  const platform = meta?.platforms.find((p) => p.os === os && p.arch === arch);
  if (!platform) return new Response("Not Found", { status: 404 });
  return serveRegistryBlob(ctx, {
    digest: platform.blobDigest,
    kind: PROVIDER_ZIP_KIND,
    scope: providerZipScope(namespace, type, version, os, arch),
    contentType: "application/zip",
    redirect: req.method === "GET",
    blocked: () => new Response("blocked by scan policy", { status: 403 }),
  });
}

/** `GET /v1/providers/:namespace/:type/:version/shasums` — serve the SHASUMS file. */
export async function serveProviderShasums(
  namespace: string,
  type: string,
  version: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const meta = await findLiveProvider(ctx, namespace, type, version);
  if (!meta) return new Response("Not Found", { status: 404 });
  return serveRegistryBlob(ctx, {
    digest: meta.shasumsDigest,
    kind: PROVIDER_SHASUMS_KIND,
    scope: providerShasumsScope(namespace, type, version, "SHASUMS"),
    contentType: "text/plain; charset=utf-8",
    redirect: req.method === "GET",
    blocked: () => new Response("blocked by scan policy", { status: 403 }),
  });
}

/** `GET /v1/providers/:namespace/:type/:version/shasums.sig` — serve the SHASUMS signature. */
export async function serveProviderShasumsSignature(
  namespace: string,
  type: string,
  version: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const meta = await findLiveProvider(ctx, namespace, type, version);
  if (!meta?.shasumsSignatureDigest) return new Response("Not Found", { status: 404 });
  return serveRegistryBlob(ctx, {
    digest: meta.shasumsSignatureDigest,
    kind: PROVIDER_SHASUMS_KIND,
    scope: providerShasumsScope(namespace, type, version, "SHASUMS.sig"),
    contentType: "application/octet-stream",
    redirect: req.method === "GET",
    blocked: () => new Response("blocked by scan policy", { status: 403 }),
  });
}

async function findLiveProvider(
  ctx: RegistryRequestContext,
  namespace: string,
  type: string,
  version: string,
): Promise<TerraformProviderVersionMeta | null> {
  const pkg = await ctx.data.packages.findByName(providerPackageName(namespace, type));
  if (!pkg) return null;
  const row = await ctx.data.versions.findLive(pkg, version);
  return row ? parseTerraformProviderVersionMeta(row.metadata) : null;
}

/**
 * `PUT /v1/providers/:namespace/:type` — publish a provider version: multiple
 * platform zips plus a SHASUMS file (and optional signature). Each blob is
 * stored in CAS; the version row records the platform builds + checksum
 * coordinates the download routes resolve against.
 */
export async function publishProviderVersion(
  namespace: string,
  type: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseTerraformProviderPublishRequest(req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  const { version } = parsed.plan;
  const packageName = providerPackageName(namespace, type);

  const pkg = await ctx.data.packages.findOrCreate({ name: packageName });
  if (await ctx.data.versions.exists(pkg, version)) {
    return Response.json({ error: "version already exists" }, { status: 409 });
  }

  // Store every platform zip in CAS, recording its blob coordinates for the meta.
  const platforms: TerraformProviderPlatform[] = [];
  let totalBytes = 0;
  for (const platform of parsed.plan.platforms) {
    const scope = providerZipScope(namespace, type, version, platform.os, platform.arch);
    const stored = await ctx.data.content.storeBlobWithRef({
      data: platform.zip,
      kind: PROVIDER_ZIP_KIND,
      scope,
      mediaType: "application/zip",
    });
    totalBytes += platform.zip.length;
    platforms.push({
      os: platform.os,
      arch: platform.arch,
      filename: platform.filename,
      blobDigest: stored.digest,
      shasum: platform.shasum,
    });
  }

  // Store the SHASUMS file (used as the version's committed primary blob).
  const shasumsScope = providerShasumsScope(namespace, type, version, "SHASUMS");
  const shasumsStored = await ctx.data.content.storeBlobWithRef({
    data: parsed.plan.shasums.data,
    kind: PROVIDER_SHASUMS_KIND,
    scope: shasumsScope,
    mediaType: "text/plain; charset=utf-8",
  });
  totalBytes += parsed.plan.shasums.data.length;

  // Store the optional SHASUMS signature.
  let shasumsSignatureDigest: string | undefined;
  if (parsed.plan.shasumsSignature) {
    const sigScope = providerShasumsScope(namespace, type, version, "SHASUMS.sig");
    const sigStored = await ctx.data.content.storeBlobWithRef({
      data: parsed.plan.shasumsSignature.data,
      kind: PROVIDER_SHASUMS_KIND,
      scope: sigScope,
      mediaType: "application/octet-stream",
    });
    shasumsSignatureDigest = sigStored.digest;
    totalBytes += parsed.plan.shasumsSignature.data.length;
  }

  const metadata: TerraformProviderVersionMeta & Record<string, unknown> = {
    kind: "provider",
    namespace,
    type,
    version,
    protocols: parsed.plan.protocols,
    platforms,
    shasumsDigest: shasumsStored.digest,
    shasumsFilename: parsed.plan.shasums.filename,
  };
  if (shasumsSignatureDigest) {
    metadata.shasumsSignatureDigest = shasumsSignatureDigest;
    metadata.shasumsSignatureFilename = parsed.plan.shasumsSignature?.filename;
  }
  if (parsed.plan.signingKeys.length > 0) metadata.signingKeys = parsed.plan.signingKeys;

  const result = await ctx.data.versions.commitOrReleaseBlob({
    stored: shasumsStored,
    kind: PROVIDER_SHASUMS_KIND,
    scope: shasumsScope,
    package: pkg,
    version,
    metadata,
    sizeBytes: totalBytes,
    // The committed blob is the SHASUMS file; scan it as text/plain to match its
    // stored media type. The per-platform zips are scanned via enqueueScan below.
    scan: { name: packageName, version, mediaType: "text/plain; charset=utf-8" },
  });
  if ("conflict" in result) {
    return Response.json({ error: "version already exists" }, { status: 409 });
  }

  // Scan the actual provider zips: commitOrReleaseBlob only enqueues the SHASUMS
  // text file, so the executable payloads would otherwise bypass the scan pipeline.
  for (const platform of platforms) {
    await ctx.enqueueScan({
      digest: platform.blobDigest,
      name: packageName,
      version,
      mediaType: "application/zip",
    });
  }

  return Response.json({ ok: true, namespace, type, version }, { status: 201 });
}

/** Every CAS digest a stored provider version references (for retention/scan). */
export function providerReferencedDigests(meta: TerraformProviderVersionMeta): string[] {
  const out = new Set<string>([meta.shasumsDigest]);
  for (const platform of meta.platforms) out.add(platform.blobDigest);
  if (meta.shasumsSignatureDigest) out.add(meta.shasumsSignatureDigest);
  return [...out];
}
