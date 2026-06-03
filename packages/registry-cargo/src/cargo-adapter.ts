import {
  bearerAuthChallenge,
  defineRegistryPlugin,
  Errors,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteEntry,
  type RouteMatch,
  readWritePermission,
  registryRoute,
  serveRegistryBlob,
} from "@hootifactory/registry";
import {
  buildCargoOwnersBody,
  buildCargoOwnersUpdateBody,
  parseCargoOwnersRequest,
} from "./cargo-owners";
import { handleCargoPublish } from "./cargo-publish-lifecycle";
import {
  CargoCrateNameSchema,
  CargoIndexPathSchema,
  CargoVersionSchema,
  cargoIndexPath,
  parseCargoVersionMeta,
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
  readonly format = "cargo" as const;
  readonly capabilities = {
    contentAddressable: false,
    resumableUploads: false,
    proxyable: false,
    virtualizable: true,
  };
  authChallenge = () => bearerAuthChallenge();

  private readonly plugin = defineRegistryPlugin({
    format: this.format,
    capabilities: this.capabilities,
    authChallenge: this.authChallenge,
    routes: [
      registryRoute({
        method: "GET",
        pattern: "/config.json",
        handlerId: "config",
        handler: ({ ctx }) =>
          Response.json({
            dl: `${ctx.baseUrl}/${ctx.repo.mountPath}/api/v1/crates`,
            api: `${ctx.baseUrl}/${ctx.repo.mountPath}`,
          }),
      }),
      registryRoute({
        method: "PUT",
        pattern: "/api/v1/crates/new",
        handlerId: "publish",
        handler: ({ req, ctx }) => this.publish(req, ctx),
      }),
      registryRoute({
        method: "GET",
        pattern: "/api/v1/crates/:crate/:version/download",
        handlerId: "download",
        handler: ({ params, ctx }) => this.download(params.crate ?? "", params.version ?? "", ctx),
      }),
      registryRoute({
        method: "DELETE",
        pattern: "/api/v1/crates/:crate/:version/yank",
        handlerId: "yank",
        handler: ({ params, ctx }) =>
          this.setYank(params.crate ?? "", params.version ?? "", true, ctx),
      }),
      registryRoute({
        method: "PUT",
        pattern: "/api/v1/crates/:crate/:version/unyank",
        handlerId: "unyank",
        handler: ({ params, ctx }) =>
          this.setYank(params.crate ?? "", params.version ?? "", false, ctx),
      }),
      registryRoute({
        method: "GET",
        pattern: "/api/v1/crates/:crate/owners",
        handlerId: "ownersList",
        handler: ({ params, ctx }) => this.listOwners(params.crate ?? "", ctx),
      }),
      registryRoute({
        method: "PUT",
        pattern: "/api/v1/crates/:crate/owners",
        handlerId: "ownersAdd",
        handler: ({ params, req, ctx }) => this.updateOwners(params.crate ?? "", req, "add", ctx),
      }),
      registryRoute({
        method: "DELETE",
        pattern: "/api/v1/crates/:crate/owners",
        handlerId: "ownersRemove",
        handler: ({ params, req, ctx }) =>
          this.updateOwners(params.crate ?? "", req, "remove", ctx),
      }),
      registryRoute({
        method: "GET",
        pattern: "/:path+",
        handlerId: "index",
        handler: ({ params, ctx }) => this.index(params.path ?? "", ctx),
      }),
    ],
  });

  routes(): RouteEntry[] {
    return this.plugin.routes();
  }

  requiredPermission(method: HttpMethod): Permission {
    return readWritePermission(method);
  }

  async handle(match: RouteMatch, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return this.plugin.handle(match, req, ctx);
  }

  private findCrate(ctx: RegistryRequestContext, name: string) {
    return ctx.data.packages.findByName(name.toLowerCase());
  }

  private async index(path: string, ctx: RegistryRequestContext): Promise<Response> {
    path = parseRegistryInput(CargoIndexPathSchema, path, {
      code: "NAME_INVALID",
      message: "invalid cargo index path",
    });
    const name = (path.split("/").pop() ?? "").toLowerCase();
    // The request path must equal the canonical sparse-index shard for the crate.
    if (path !== cargoIndexPath(name)) return new Response("", { status: 404 });
    const pkg = await this.findCrate(ctx, name);
    if (!pkg) return new Response("", { status: 404 });
    const vers = await ctx.data.versions.listLive(pkg.id, { orderByCreated: "asc" });
    const lines = vers
      .flatMap((v) => {
        const metadata = parseCargoVersionMeta(v.metadata);
        return metadata ? [JSON.stringify(metadata.index)] : [];
      })
      .join("\n");
    return new Response(`${lines}\n`, { headers: { "content-type": "text/plain" } });
  }

  private async download(
    crate: string,
    version: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    crate = parseCrateName(crate);
    version = parseCrateVersion(version);
    const pkg = await this.findCrate(ctx, crate);
    if (!pkg) throw Errors.notFound();
    const v = await ctx.data.versions.findLive(pkg.id, version);
    const digest = parseCargoVersionMeta(v?.metadata)?.crateDigest;
    if (!digest || !(await ctx.blobs.exists(digest))) throw Errors.notFound();
    return serveRegistryBlob(ctx, {
      digest,
      contentType: "application/octet-stream",
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
    const v = await ctx.data.versions.findLive(pkg.id, version);
    if (!v) throw Errors.notFound();
    const meta = parseCargoVersionMeta(v.metadata);
    if (!meta) throw Errors.notFound();
    await ctx.data.versions.updateMetadata(v.id, {
      ...meta,
      index: { ...meta.index, yanked },
    });
    return Response.json({ ok: true });
  }

  private async listOwners(crate: string, ctx: RegistryRequestContext): Promise<Response> {
    crate = parseCrateName(crate).toLowerCase();
    const pkg = await this.findCrate(ctx, crate);
    if (!pkg) throw Errors.notFound();
    const rows = await ctx.data.versions.listPublishers(pkg.id);
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

export const cargoRegistryPlugin: RegistryPlugin = new CargoAdapter();
