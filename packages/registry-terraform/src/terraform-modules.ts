import {
  digestHex,
  jsonResponseWithEtag,
  publishImmutableVersionBlob,
  type RegistryRequestContext,
  serveRegistryBlob,
} from "@hootifactory/registry";
import { parseTerraformModulePublishRequest } from "./terraform-publish";
import {
  parseTerraformModuleVersionMeta,
  type TerraformModuleVersionMeta,
} from "./terraform-validation";

export const MODULE_BLOB_KIND = "terraform_module";

/** Package name a module is stored under: `module/<namespace>/<name>/<system>`. */
export function modulePackageName(namespace: string, name: string, system: string): string {
  return `module/${namespace}/${name}/${system}`;
}

/** Stable blob-ref scope for a published module archive. */
export function moduleBlobScope(
  namespace: string,
  name: string,
  system: string,
  version: string,
): string {
  return `${namespace}/${name}/${system}@${version}`;
}

async function liveModuleMetas(
  ctx: RegistryRequestContext,
  pkg: { id: string; orgId: string; repositoryId: string; name: string },
): Promise<TerraformModuleVersionMeta[]> {
  const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" });
  return rows.flatMap((row) => {
    const meta = parseTerraformModuleVersionMeta(row.metadata);
    return meta ? [meta] : [];
  });
}

/**
 * `GET /v1/modules/:namespace/:name/:system/versions` —
 * `{ modules: [{ versions: [{ version }] }] }` over the package's live versions.
 */
export async function listModuleVersions(
  namespace: string,
  name: string,
  system: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const pkg = await ctx.data.packages.findByName(modulePackageName(namespace, name, system));
  if (!pkg) return new Response("Not Found", { status: 404 });
  const metas = await liveModuleMetas(ctx, pkg);
  if (metas.length === 0) return new Response("Not Found", { status: 404 });
  const body = {
    modules: [{ versions: metas.map((meta) => ({ version: meta.version })) }],
  };
  return jsonResponseWithEtag(req, body);
}

/**
 * `GET /v1/modules/:namespace/:name/:system/:version/download` — 204 with an
 * `X-Terraform-Get` header pointing at the hosted module archive blob.
 */
export async function moduleDownloadRedirect(
  namespace: string,
  name: string,
  system: string,
  version: string,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const meta = await findLiveModule(ctx, namespace, name, system, version);
  if (!meta) return new Response("Not Found", { status: 404 });
  // The `?archive=tar.gz` hint is REQUIRED: go-getter (which fetches the module
  // from X-Terraform-Get) selects the decompressor from the URL, not the response
  // Content-Type. A bare `/archive` path would be treated as a single raw file and
  // never extracted, so `terraform init` would find no .tf files. The archive blob
  // is published as a gzip tarball (mediaType application/gzip).
  const archiveUrl = `${ctx.baseUrl}/${ctx.repo.mountPath}/v1/modules/${encodeURIComponent(
    namespace,
  )}/${encodeURIComponent(name)}/${encodeURIComponent(system)}/${encodeURIComponent(
    version,
  )}/archive?archive=tar.gz`;
  return new Response(null, {
    status: 204,
    headers: { "x-terraform-get": archiveUrl },
  });
}

/** `GET /v1/modules/:namespace/:name/:system/:version/archive` — serve the archive blob. */
export async function serveModuleArchive(
  namespace: string,
  name: string,
  system: string,
  version: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const meta = await findLiveModule(ctx, namespace, name, system, version);
  if (!meta) return new Response("Not Found", { status: 404 });
  return serveRegistryBlob(ctx, {
    digest: meta.blobDigest,
    kind: MODULE_BLOB_KIND,
    scope: moduleBlobScope(namespace, name, system, version),
    contentType: "application/gzip",
    redirect: req.method === "GET",
    blocked: () => new Response("blocked by scan policy", { status: 403 }),
  });
}

async function findLiveModule(
  ctx: RegistryRequestContext,
  namespace: string,
  name: string,
  system: string,
  version: string,
): Promise<TerraformModuleVersionMeta | null> {
  const pkg = await ctx.data.packages.findByName(modulePackageName(namespace, name, system));
  if (!pkg) return null;
  const row = await ctx.data.versions.findLive(pkg, version);
  return row ? parseTerraformModuleVersionMeta(row.metadata) : null;
}

/** `PUT /v1/modules/:namespace/:name/:system` — publish a module version archive. */
export async function publishModuleVersion(
  namespace: string,
  name: string,
  system: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseTerraformModulePublishRequest(namespace, name, system, req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  const { version, archive, filename } = parsed.plan;
  const packageName = modulePackageName(namespace, name, system);
  const scope = moduleBlobScope(namespace, name, system, version);

  const result = await publishImmutableVersionBlob(ctx, {
    package: { name: packageName },
    version,
    kind: MODULE_BLOB_KIND,
    scope,
    blob: {
      data: archive,
      kind: MODULE_BLOB_KIND,
      scope,
      mediaType: "application/gzip",
    },
    metadata: (stored): TerraformModuleVersionMeta & Record<string, unknown> => ({
      kind: "module",
      namespace,
      name,
      system,
      version,
      blobDigest: stored.digest,
      sha256: digestHex(stored.digest),
      filename,
    }),
    sizeBytes: archive.length,
    scan: { name: packageName, version, mediaType: "application/gzip" },
    asset: (stored) => ({
      role: MODULE_BLOB_KIND,
      scope,
      path: filename,
      mediaType: "application/gzip",
      metadata: { namespace, name, system, version, sha256: digestHex(stored.digest) },
    }),
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, version),
  });
  if (!result.ok) {
    return Response.json({ error: "version already exists" }, { status: 409 });
  }
  return Response.json({ ok: true, namespace, name, system, version }, { status: 201 });
}
