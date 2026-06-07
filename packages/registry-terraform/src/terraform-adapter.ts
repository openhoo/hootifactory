import {
  basicAuthChallenge,
  delegateRegistryPlugin,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryAppRoute,
  type RegistryAppRouteContext,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
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
export class TerraformAdapter implements RegistryPlugin {
  readonly id = "terraform" as const;
  // `proxyable` is intentionally NOT declared: the adapter implements no
  // `proxyIngest` / upstream-mirror, so proxy repos cannot be created or served.
  // Advertising it would be dishonest (and the platform gates proxy creation on
  // `!adapter.proxyIngest`, so it would never work anyway).
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Terraform",
      mountSegment: MOUNT_SEGMENT,
      errorResponseKind: "singleError",
      compressibleHandlers: ["discovery", "moduleVersions", "providerVersions", "providerDownload"],
      appRoutes: terraformAppRoutes(),
      scan: {
        defaultOsvEcosystem: undefined,
        referencedDigests: (metadata) => terraformReferencedDigests(metadata),
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // ── service discovery (repo-scoped) ──────────────────────────────────
      // The authoritative per-repo discovery doc, reachable under the repo mount;
      // its modules.v1/providers.v1 carry the full `terraform/<org>/<repo>` path.
      route.get("/.well-known/terraform.json", "discovery", (i) =>
        Promise.resolve(serveTerraformDiscoveryDoc(i.req, i.ctx)),
      ),
      // ── module protocol ──────────────────────────────────────────────────
      // `versions` and `archive` are literal trailing segments; they're declared
      // before the `:version/download` catch-all so the matcher can't shadow them.
      route.get("/v1/modules/:namespace/:name/:system/versions", "moduleVersions", (i) =>
        this.moduleVersions(i.params, i.req, i.ctx),
      ),
      route.get("/v1/modules/:namespace/:name/:system/:version/archive", "moduleArchive", (i) =>
        this.moduleArchive(i.params, i.req, i.ctx),
      ),
      route.get("/v1/modules/:namespace/:name/:system/:version/download", "moduleDownload", (i) =>
        this.moduleDownload(i.params, i.ctx),
      ),
      route.put("/v1/modules/:namespace/:name/:system", "modulePublish", (i) =>
        this.modulePublish(i.params, i.req, i.ctx),
      ),
      // ── provider protocol ────────────────────────────────────────────────
      route.get("/v1/providers/:namespace/:type/versions", "providerVersions", (i) =>
        this.providerVersions(i.params, i.req, i.ctx),
      ),
      route.get(
        "/v1/providers/:namespace/:type/:version/download/:os/:arch/zip",
        "providerZip",
        (i) => this.providerZip(i.params, i.req, i.ctx),
      ),
      route.get(
        "/v1/providers/:namespace/:type/:version/download/:os/:arch",
        "providerDownload",
        (i) => this.providerDownload(i.params, i.req, i.ctx),
      ),
      route.get("/v1/providers/:namespace/:type/:version/shasums", "providerShasums", (i) =>
        this.providerShasums(i.params, i.req, i.ctx),
      ),
      route.get("/v1/providers/:namespace/:type/:version/shasums.sig", "providerShasumsSig", (i) =>
        this.providerShasumsSig(i.params, i.req, i.ctx),
      ),
      route.put("/v1/providers/:namespace/:type", "providerPublish", (i) =>
        this.providerPublish(i.params, i.req, i.ctx),
      ),
    ])
    .build();
  private readonly delegate = delegateRegistryPlugin(this.plugin);

  get displayName() {
    return this.plugin.displayName;
  }
  get mountSegment() {
    return this.plugin.mountSegment;
  }
  get repositoryNamePolicy() {
    return this.plugin.repositoryNamePolicy;
  }
  get acceptsRegistryBearerToken() {
    return this.plugin.acceptsRegistryBearerToken;
  }
  get apiKeyHeaders() {
    return this.plugin.apiKeyHeaders;
  }
  get errorResponseKind() {
    return this.plugin.errorResponseKind;
  }
  get compressibleHandlers() {
    return this.plugin.compressibleHandlers;
  }
  get compressibleContentTypes() {
    return this.plugin.compressibleContentTypes;
  }
  get scan() {
    return this.plugin.scan;
  }

  routes = this.delegate.routes;

  appRoutes(): RegistryAppRoute[] {
    return this.plugin.appRoutes?.() ?? [];
  }

  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    const permission = readWritePermission(method);
    const packageName = this.packageNameFromMatch(match);
    if (packageName) {
      return { ...permission, resource: { type: "package", packageName } };
    }
    return permission;
  }

  handle = this.delegate.handle;

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

  private moduleVersions(
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

  private moduleArchive(
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

  private moduleDownload(
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

  private modulePublish(
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

  private providerVersions(
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

  private providerDownload(
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

  private providerZip(
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

  private providerShasums(
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

  private providerShasumsSig(
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

  private providerPublish(
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

export const terraformRegistryPlugin: RegistryPlugin = new TerraformAdapter();
