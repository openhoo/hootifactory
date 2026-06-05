import {
  bearerAuthChallenge,
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import {
  buildCargoOwnersBody,
  buildCargoOwnersUpdateBody,
  parseCargoOwnersRequest,
} from "./cargo-owners";
import { cargoBlobScope } from "./cargo-publish";
import { handleCargoPublish } from "./cargo-publish-lifecycle";
import {
  CargoCrateNameSchema,
  CargoIndexPathSchema,
  CargoVersionSchema,
  cargoIndexPath,
  parseCargoVersionMeta,
  readCargoIndexEntry,
} from "./cargo-validation";

function parseCrateName(crate: string): string {
  return parseRegistryInput(CargoCrateNameSchema, crate, {
    code: "NAME_INVALID",
    message: "invalid crate name",
  });
}

function parseCrateVersion(version: string): string {
  return parseRegistryInput(CargoVersionSchema, version, {
    code: "MANIFEST_INVALID",
    message: "invalid crate version",
  });
}

/** Cargo sparse registry: config.json, sharded index, publish + download. */
export class CargoAdapter implements RegistryPlugin {
  readonly id = "cargo" as const;
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = () => bearerAuthChallenge();

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Cargo",
      mountSegment: "cargo",
      errorResponseKind: "errorsDetail",
      compressibleHandlers: ["config", "index", "ownersList"],
      scan: {
        defaultOsvEcosystem: "crates.io",
        dependencyGraph: ({ metadata }) => ({
          deps: cargoDependencyGraph(metadata),
          osvEcosystem: "crates.io",
          purlType: "cargo",
        }),
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      route.get("/config.json", "config", ({ ctx }) =>
        Response.json({
          dl: `${ctx.baseUrl}/${ctx.repo.mountPath}/api/v1/crates`,
          api: `${ctx.baseUrl}/${ctx.repo.mountPath}`,
        }),
      ),
      route.put("/api/v1/crates/new", "publish", ({ req, ctx }) => this.publish(req, ctx)),
      route.get("/api/v1/crates/:crate/:version/download", "download", ({ params, req, ctx }) =>
        this.download(params.crate, params.version, req, ctx),
      ),
      route.delete("/api/v1/crates/:crate/:version/yank", "yank", ({ params, ctx }) =>
        this.setYank(params.crate, params.version, true, ctx),
      ),
      route.put("/api/v1/crates/:crate/:version/unyank", "unyank", ({ params, ctx }) =>
        this.setYank(params.crate, params.version, false, ctx),
      ),
      route.get("/api/v1/crates/:crate/owners", "ownersList", ({ params, ctx }) =>
        this.listOwners(params.crate, ctx),
      ),
      route.put("/api/v1/crates/:crate/owners", "ownersAdd", ({ params, req, ctx }) =>
        this.updateOwners(params.crate, req, "add", ctx),
      ),
      route.delete("/api/v1/crates/:crate/owners", "ownersRemove", ({ params, req, ctx }) =>
        this.updateOwners(params.crate, req, "remove", ctx),
      ),
      route.get("/:path+", "index", ({ params, req, ctx }) => this.index(params.path, req, ctx)),
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

  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    const permission = readWritePermission(method);
    const crate = match?.params.crate;
    const version = match?.params.version;
    if (crate && version && match?.entry?.handlerId === "download") {
      return {
        ...permission,
        resource: {
          type: "artifact",
          packageName: crate.toLowerCase(),
          artifactRef: cargoBlobScope(crate.toLowerCase(), version),
        },
      };
    }
    if (crate) {
      return { ...permission, resource: { type: "package", packageName: crate.toLowerCase() } };
    }
    return permission;
  }

  handle = this.delegate.handle;

  private findCrate(ctx: RegistryRequestContext, name: string) {
    return ctx.data.packages.findByName(name.toLowerCase());
  }

  private async index(path: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    path = parseRegistryInput(CargoIndexPathSchema, path, {
      code: "NAME_INVALID",
      message: "invalid cargo index path",
    });
    const name = (path.split("/").pop() ?? "").toLowerCase();
    // The request path must equal the canonical sparse-index shard for the crate.
    if (path !== cargoIndexPath(name)) return new Response("", { status: 404 });
    const pkg = await this.findCrate(ctx, name);
    if (!pkg) return new Response("", { status: 404 });
    const vers = await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" });
    const lines = vers
      .flatMap((v) => {
        const index = readCargoIndexEntry(v.metadata);
        return index ? [JSON.stringify(index)] : [];
      })
      .join("\n");
    return textResponseWithEtag(req, `${lines}\n`, { "content-type": "text/plain" });
  }

  private async download(
    crate: string,
    version: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    crate = parseCrateName(crate);
    version = parseCrateVersion(version);
    const pkg = await this.findCrate(ctx, crate);
    if (!pkg) throw Errors.notFound();
    const v = await ctx.data.versions.findLive(pkg, version);
    const digest = parseCargoVersionMeta(v?.metadata)?.crateDigest;
    if (!digest) throw Errors.notFound();
    return serveRegistryBlob(ctx, {
      digest,
      kind: "generic_file",
      scope: cargoBlobScope(crate, version),
      contentType: "application/octet-stream",
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  /** Toggle the yanked flag in a crate version's stored index entry. */
  private async setYank(
    crate: string,
    version: string,
    yanked: boolean,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    crate = parseCrateName(crate);
    version = parseCrateVersion(version);
    const pkg = await this.findCrate(ctx, crate);
    if (!pkg) throw Errors.notFound();
    const v = await ctx.data.versions.findLive(pkg, version);
    if (!v) throw Errors.notFound();
    const meta = parseCargoVersionMeta(v.metadata);
    if (!meta) throw Errors.notFound();
    await ctx.data.versions.updateMetadata(v, {
      ...meta,
      index: { ...meta.index, yanked },
    });
    return Response.json({ ok: true });
  }

  private async listOwners(crate: string, ctx: RegistryRequestContext): Promise<Response> {
    crate = parseCrateName(crate).toLowerCase();
    const pkg = await this.findCrate(ctx, crate);
    if (!pkg) throw Errors.notFound();
    const rows = await ctx.data.versions.listPublishers(pkg);
    return Response.json(buildCargoOwnersBody(rows));
  }

  private async updateOwners(
    crate: string,
    req: Request,
    action: "add" | "remove",
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    crate = parseCrateName(crate).toLowerCase();
    const pkg = await this.findCrate(ctx, crate);
    if (!pkg) throw Errors.notFound();
    const body = await parseCargoOwnersRequest(req);
    return Response.json(buildCargoOwnersUpdateBody(body.users.length, action));
  }

  private async publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleCargoPublish(req, ctx);
  }
}

function cargoDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const parsed = parseCargoVersionMeta(metadata);
  if (!parsed) return {};
  return Object.fromEntries(parsed.index.deps.map((dep) => [dep.name, dep.req]));
}

export const cargoRegistryPlugin: RegistryPlugin = new CargoAdapter();
