import {
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryAppRoute,
  type RegistryAppRouteContext,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryAdapter,
  textResponseWithEtag,
} from "@hootifactory/registry";
import {
  listModuleVersions,
  moduleDownloadRedirect,
  modulePackageName,
  publishModuleVersion,
  serveModuleArchive,
} from "./terraform-modules";
import {
  listProviderVersions,
  providerDownloadInfo,
  providerPackageName,
  providerReferencedDigests,
  publishProviderVersion,
  serveProviderShasums,
  serveProviderShasumsSignature,
  serveProviderZip,
} from "./terraform-providers";
import {
  buildTerraformDiscoveryDoc,
  parseTerraformModuleVersionMeta,
  parseTerraformProviderVersionMeta,
  TerraformIdentifierSchema,
  TerraformPlatformTokenSchema,
  TerraformVersionSchema,
} from "./terraform-validation";

const MOUNT_SEGMENT = "terraform";

function parseIdentifier(value: string): string {
  return parseRegistryInput(TerraformIdentifierSchema, value, {
    code: "NAME_INVALID",
    message: "invalid Terraform identifier",
  });
}

function parseVersion(value: string): string {
  return parseRegistryInput(TerraformVersionSchema, value, {
    code: "MANIFEST_INVALID",
    message: "invalid Terraform version",
  });
}

function parsePlatformToken(value: string): string {
  return parseRegistryInput(TerraformPlatformTokenSchema, value, {
    code: "NAME_INVALID",
    message: "invalid platform token",
  });
}

function discoveryResponse(mountPath: string): Response {
  return new Response(JSON.stringify(buildTerraformDiscoveryDoc(mountPath)), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * The host-level service-discovery document Terraform fetches before any
 * registry call. Terraform always requests `<host>/.well-known/terraform.json`
 * at the host root, then resolves `modules.v1`/`providers.v1` relative to it and
 * appends `<namespace>/<name>/<system>` directly — so the advertised base MUST
 * include the repository mount path (`terraform/<org>/<repo>`), or the resolved
 * request lands on a path no repository is mounted at and 404s.
 *
 * Because a repository is mounted per `<org>/<repo>`, this host-level route tries
 * to resolve the concrete repository from the request URL and advertise its real
 * mount path; if no repository can be resolved from the host root it falls back
 * to the bare mount segment (the repo-mounted `/.well-known/terraform.json` route
 * declared in {@link TerraformAdapter.routes} carries the authoritative per-repo
 * document for deployments addressed under the repo mount).
 */
export function terraformAppRoutes(): RegistryAppRoute[] {
  const handler = async (ctx: RegistryAppRouteContext): Promise<Response> => {
    const resolved = await ctx.resolveRepository(ctx.url.pathname);
    const mountPath =
      resolved?.repo.moduleId === "terraform" ? resolved.repo.mountPath : MOUNT_SEGMENT;
    return discoveryResponse(mountPath);
  };
  return [
    { method: "GET", pattern: "/.well-known/terraform.json", handler },
    { method: "HEAD", pattern: "/.well-known/terraform.json", handler },
  ];
}

/**
 * Repo-mounted `GET /.well-known/terraform.json` — the authoritative per-repo
 * discovery document. Reachable at `terraform/<org>/<repo>/.well-known/terraform.json`,
 * it advertises `modules.v1`/`providers.v1` built from `ctx.repo.mountPath`, the
 * same full mount path the download / archive URL builders already use.
 */
export function serveTerraformDiscoveryDoc(req: Request, ctx: RegistryRequestContext): Response {
  return textResponseWithEtag(req, JSON.stringify(buildTerraformDiscoveryDoc(ctx.repo.mountPath)), {
    "content-type": "application/json; charset=utf-8",
  });
}

/**
 * Terraform registry: both the Module Registry Protocol (`/v1/modules/...`) and
 * the Provider Registry Protocol (`/v1/providers/...`), plus a hootifactory
 * publish extension (`PUT`) and the host-level service-discovery document.
 */
class TerraformAdapterState {
  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    const permission = readWritePermission(method);
    const packageName = this.packageNameFromMatch(match);
    if (packageName) {
      return { ...permission, resource: { type: "package", packageName } };
    }
    return permission;
  }

  /** Resolve the stored package name a matched route addresses, if valid. */
  private packageNameFromMatch(match?: RouteMatch): string | null {
    const params = match?.params;
    if (!params) return null;
    if (params.name !== undefined) {
      if (
        !isIdentifier(params.namespace) ||
        !isIdentifier(params.name) ||
        !isIdentifier(params.system)
      ) {
        return null;
      }
      return modulePackageName(params.namespace, params.name, params.system);
    }
    if (params.type !== undefined) {
      if (!isIdentifier(params.namespace) || !isIdentifier(params.type)) return null;
      return providerPackageName(params.namespace, params.type);
    }
    return null;
  }

  // ── module handlers ────────────────────────────────────────────────────────

  moduleVersions(
    params: { namespace: string; name: string; system: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return listModuleVersions(
      parseIdentifier(params.namespace),
      parseIdentifier(params.name),
      parseIdentifier(params.system),
      req,
      ctx,
    );
  }

  moduleArchive(
    params: { namespace: string; name: string; system: string; version: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return serveModuleArchive(
      parseIdentifier(params.namespace),
      parseIdentifier(params.name),
      parseIdentifier(params.system),
      parseVersion(params.version),
      req,
      ctx,
    );
  }

  moduleDownload(
    params: { namespace: string; name: string; system: string; version: string },
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return moduleDownloadRedirect(
      parseIdentifier(params.namespace),
      parseIdentifier(params.name),
      parseIdentifier(params.system),
      parseVersion(params.version),
      ctx,
    );
  }

  modulePublish(
    params: { namespace: string; name: string; system: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return publishModuleVersion(
      parseIdentifier(params.namespace),
      parseIdentifier(params.name),
      parseIdentifier(params.system),
      req,
      ctx,
    );
  }

  // ── provider handlers ───────────────────────────────────────────────────────

  providerVersions(
    params: { namespace: string; type: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return listProviderVersions(
      parseIdentifier(params.namespace),
      parseIdentifier(params.type),
      req,
      ctx,
    );
  }

  providerDownload(
    params: { namespace: string; type: string; version: string; os: string; arch: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return providerDownloadInfo(
      parseIdentifier(params.namespace),
      parseIdentifier(params.type),
      parseVersion(params.version),
      parsePlatformToken(params.os),
      parsePlatformToken(params.arch),
      req,
      ctx,
    );
  }

  providerZip(
    params: { namespace: string; type: string; version: string; os: string; arch: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return serveProviderZip(
      parseIdentifier(params.namespace),
      parseIdentifier(params.type),
      parseVersion(params.version),
      parsePlatformToken(params.os),
      parsePlatformToken(params.arch),
      req,
      ctx,
    );
  }

  providerShasums(
    params: { namespace: string; type: string; version: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return serveProviderShasums(
      parseIdentifier(params.namespace),
      parseIdentifier(params.type),
      parseVersion(params.version),
      req,
      ctx,
    );
  }

  providerShasumsSig(
    params: { namespace: string; type: string; version: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return serveProviderShasumsSignature(
      parseIdentifier(params.namespace),
      parseIdentifier(params.type),
      parseVersion(params.version),
      req,
      ctx,
    );
  }

  providerPublish(
    params: { namespace: string; type: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return publishProviderVersion(
      parseIdentifier(params.namespace),
      parseIdentifier(params.type),
      req,
      ctx,
    );
  }
}

function isIdentifier(value: string | undefined): value is string {
  return value !== undefined && TerraformIdentifierSchema.safeParse(value).success;
}

/** CAS digests referenced by a stored module or provider version. */
function terraformReferencedDigests(metadata: Record<string, unknown>): string[] {
  const moduleMeta = parseTerraformModuleVersionMeta(metadata);
  if (moduleMeta) return [moduleMeta.blobDigest];
  const providerMeta = parseTerraformProviderVersionMeta(metadata);
  if (providerMeta) return providerReferencedDigests(providerMeta);
  return [];
}

const terraformDefinition = registryAdapter("terraform")
  .stateClass(TerraformAdapterState)
  .module((module) =>
    module
      .displayName("Terraform")
      .mount(MOUNT_SEGMENT)
      // No proxyable capability: this adapter has no proxyIngest/upstream mirror.
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("discovery", "moduleVersions", "providerVersions", "providerDownload")
      .appRoutes(terraformAppRoutes()),
  )
  .scan({
    defaultOsvEcosystem: undefined,
    referencedDigests: (metadata) => terraformReferencedDigests(metadata),
  })
  .basicAuth()
  .fromState((state) => state.defaultPermission("requiredPermission"))
  .routes((route) => [
    // ── service discovery (repo-scoped) ──────────────────────────────────
    route
      .get("/.well-known/terraform.json", "discovery")
      .handle(({ req, ctx }) => Promise.resolve(serveTerraformDiscoveryDoc(req, ctx))),
    // ── module protocol ──────────────────────────────────────────────────
    route
      .get("/v1/modules/:namespace/:name/:system/versions", "moduleVersions")
      .calls((state, { params, req, ctx }) => state.moduleVersions(params, req, ctx)),
    route
      .get("/v1/modules/:namespace/:name/:system/:version/archive", "moduleArchive")
      .calls((state, { params, req, ctx }) => state.moduleArchive(params, req, ctx)),
    route
      .get("/v1/modules/:namespace/:name/:system/:version/download", "moduleDownload")
      .calls((state, { params, ctx }) => state.moduleDownload(params, ctx)),
    route
      .put("/v1/modules/:namespace/:name/:system", "modulePublish")
      .calls((state, { params, req, ctx }) => state.modulePublish(params, req, ctx)),
    // ── provider protocol ────────────────────────────────────────────────
    route
      .get("/v1/providers/:namespace/:type/versions", "providerVersions")
      .calls((state, { params, req, ctx }) => state.providerVersions(params, req, ctx)),
    route
      .get("/v1/providers/:namespace/:type/:version/download/:os/:arch/zip", "providerZip")
      .calls((state, { params, req, ctx }) => state.providerZip(params, req, ctx)),
    route
      .get("/v1/providers/:namespace/:type/:version/download/:os/:arch", "providerDownload")
      .calls((state, { params, req, ctx }) => state.providerDownload(params, req, ctx)),
    route
      .get("/v1/providers/:namespace/:type/:version/shasums", "providerShasums")
      .calls((state, { params, req, ctx }) => state.providerShasums(params, req, ctx)),
    route
      .get("/v1/providers/:namespace/:type/:version/shasums.sig", "providerShasumsSig")
      .calls((state, { params, req, ctx }) => state.providerShasumsSig(params, req, ctx)),
    route
      .put("/v1/providers/:namespace/:type", "providerPublish")
      .calls((state, { params, req, ctx }) => state.providerPublish(params, req, ctx)),
  ]);

export class TerraformAdapter extends terraformDefinition.adapterClass() {}
export const terraformRegistryPlugin: RegistryPlugin = new TerraformAdapter();
