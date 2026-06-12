import {
  jsonResponseWithEtag,
  type RegistryAppRoute,
  type RegistryAppRouteContext,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RegistryRouteParamSpec,
  registryAdapter,
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

const identifierParam: RegistryRouteParamSpec = {
  schema: TerraformIdentifierSchema,
  code: "NAME_INVALID",
  message: "invalid Terraform identifier",
};

const versionParam: RegistryRouteParamSpec = {
  schema: TerraformVersionSchema,
  code: "MANIFEST_INVALID",
  message: "invalid Terraform version",
};

const platformParam: RegistryRouteParamSpec = {
  schema: TerraformPlatformTokenSchema,
  code: "NAME_INVALID",
  message: "invalid platform token",
};

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
  return jsonResponseWithEtag(req, buildTerraformDiscoveryDoc(ctx.repo.mountPath));
}

/**
 * Terraform registry: both the Module Registry Protocol (`/v1/modules/...`) and
 * the Provider Registry Protocol (`/v1/providers/...`), plus a hootifactory
 * publish extension (`PUT`) and the host-level service-discovery document.
 */
class TerraformAdapterState {
  // ── module handlers ────────────────────────────────────────────────────────

  moduleVersions(
    params: { namespace: string; name: string; system: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return listModuleVersions(params.namespace, params.name, params.system, req, ctx);
  }

  moduleArchive(
    params: { namespace: string; name: string; system: string; version: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return serveModuleArchive(
      params.namespace,
      params.name,
      params.system,
      params.version,
      req,
      ctx,
    );
  }

  moduleDownload(
    params: { namespace: string; name: string; system: string; version: string },
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return moduleDownloadRedirect(
      params.namespace,
      params.name,
      params.system,
      params.version,
      ctx,
    );
  }

  modulePublish(
    params: { namespace: string; name: string; system: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return publishModuleVersion(params.namespace, params.name, params.system, req, ctx);
  }

  // ── provider handlers ───────────────────────────────────────────────────────

  providerVersions(
    params: { namespace: string; type: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return listProviderVersions(params.namespace, params.type, req, ctx);
  }

  providerDownload(
    params: { namespace: string; type: string; version: string; os: string; arch: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return providerDownloadInfo(
      params.namespace,
      params.type,
      params.version,
      params.os,
      params.arch,
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
      params.namespace,
      params.type,
      params.version,
      params.os,
      params.arch,
      req,
      ctx,
    );
  }

  providerShasums(
    params: { namespace: string; type: string; version: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return serveProviderShasums(params.namespace, params.type, params.version, req, ctx);
  }

  providerShasumsSig(
    params: { namespace: string; type: string; version: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return serveProviderShasumsSignature(params.namespace, params.type, params.version, req, ctx);
  }

  providerPublish(
    params: { namespace: string; type: string },
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return publishProviderVersion(params.namespace, params.type, req, ctx);
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
  .permissions((p) =>
    p.byParams([
      p.packageRule({
        param: "name",
        normalize: (name, { params }) =>
          isIdentifier(params.namespace) && isIdentifier(name) && isIdentifier(params.system)
            ? modulePackageName(params.namespace, name, params.system)
            : null,
      }),
      p.packageRule({
        param: "type",
        normalize: (type, { params }) =>
          isIdentifier(params.namespace) && isIdentifier(type)
            ? providerPackageName(params.namespace, type)
            : null,
      }),
    ]),
  )
  .routes((route) => [
    // ── service discovery (repo-scoped) ──────────────────────────────────
    route
      .get("/.well-known/terraform.json", "discovery")
      .handle(({ req, ctx }) => Promise.resolve(serveTerraformDiscoveryDoc(req, ctx))),
    // ── module protocol ──────────────────────────────────────────────────
    route
      .get("/v1/modules/:namespace/:name/:system/versions", "moduleVersions")
      .params({ namespace: identifierParam, name: identifierParam, system: identifierParam })
      .calls((state, { params, req, ctx }) => state.moduleVersions(params, req, ctx)),
    route
      .get("/v1/modules/:namespace/:name/:system/:version/archive", "moduleArchive")
      .params({
        namespace: identifierParam,
        name: identifierParam,
        system: identifierParam,
        version: versionParam,
      })
      .calls((state, { params, req, ctx }) => state.moduleArchive(params, req, ctx)),
    route
      .get("/v1/modules/:namespace/:name/:system/:version/download", "moduleDownload")
      .params({
        namespace: identifierParam,
        name: identifierParam,
        system: identifierParam,
        version: versionParam,
      })
      .calls((state, { params, ctx }) => state.moduleDownload(params, ctx)),
    route
      .put("/v1/modules/:namespace/:name/:system", "modulePublish")
      .params({ namespace: identifierParam, name: identifierParam, system: identifierParam })
      .calls((state, { params, req, ctx }) => state.modulePublish(params, req, ctx)),
    // ── provider protocol ────────────────────────────────────────────────
    route
      .get("/v1/providers/:namespace/:type/versions", "providerVersions")
      .params({ namespace: identifierParam, type: identifierParam })
      .calls((state, { params, req, ctx }) => state.providerVersions(params, req, ctx)),
    route
      .get("/v1/providers/:namespace/:type/:version/download/:os/:arch/zip", "providerZip")
      .params({
        namespace: identifierParam,
        type: identifierParam,
        version: versionParam,
        os: platformParam,
        arch: platformParam,
      })
      .calls((state, { params, req, ctx }) => state.providerZip(params, req, ctx)),
    route
      .get("/v1/providers/:namespace/:type/:version/download/:os/:arch", "providerDownload")
      .params({
        namespace: identifierParam,
        type: identifierParam,
        version: versionParam,
        os: platformParam,
        arch: platformParam,
      })
      .calls((state, { params, req, ctx }) => state.providerDownload(params, req, ctx)),
    route
      .get("/v1/providers/:namespace/:type/:version/shasums", "providerShasums")
      .params({ namespace: identifierParam, type: identifierParam, version: versionParam })
      .calls((state, { params, req, ctx }) => state.providerShasums(params, req, ctx)),
    route
      .get("/v1/providers/:namespace/:type/:version/shasums.sig", "providerShasumsSig")
      .params({ namespace: identifierParam, type: identifierParam, version: versionParam })
      .calls((state, { params, req, ctx }) => state.providerShasumsSig(params, req, ctx)),
    route
      .put("/v1/providers/:namespace/:type", "providerPublish")
      .params({ namespace: identifierParam, type: identifierParam })
      .calls((state, { params, req, ctx }) => state.providerPublish(params, req, ctx)),
  ]);

export class TerraformAdapter extends terraformDefinition.adapterClass() {}
export const terraformRegistryPlugin: RegistryPlugin = new TerraformAdapter();
