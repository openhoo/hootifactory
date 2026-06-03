import {
  Errors,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteEntry,
  type RouteMatch,
  readWritePermission,
} from "@hootifactory/registry";
import {
  findLiveVersion,
  findPackageByName,
  listLivePackageVersions,
  listLiveVersionPublishers,
  serveBlobIfClean,
  updatePackageVersionMetadata,
} from "@hootifactory/registry-application";
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

  routes(): RouteEntry[] {
    return [
      { method: "GET", pattern: "/config.json", handlerId: "config" },
      { method: "PUT", pattern: "/api/v1/crates/new", handlerId: "publish" },
      { method: "GET", pattern: "/api/v1/crates/:crate/:version/download", handlerId: "download" },
      { method: "DELETE", pattern: "/api/v1/crates/:crate/:version/yank", handlerId: "yank" },
      { method: "PUT", pattern: "/api/v1/crates/:crate/:version/unyank", handlerId: "unyank" },
      { method: "GET", pattern: "/api/v1/crates/:crate/owners", handlerId: "ownersList" },
      { method: "PUT", pattern: "/api/v1/crates/:crate/owners", handlerId: "ownersAdd" },
      { method: "DELETE", pattern: "/api/v1/crates/:crate/owners", handlerId: "ownersRemove" },
      { method: "GET", pattern: "/:path+", handlerId: "index" },
    ];
  }

  requiredPermission(method: HttpMethod): Permission {
    return readWritePermission(method);
  }

  authChallenge() {
    return { header: 'Bearer realm="hootifactory"', status: 401 as const };
  }

  async handle(match: RouteMatch, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    switch (match.entry.handlerId) {
      case "config":
        return Response.json({
          dl: `${ctx.baseUrl}/${ctx.repo.mountPath}/api/v1/crates`,
          api: `${ctx.baseUrl}/${ctx.repo.mountPath}`,
        });
      case "publish":
        return this.publish(req, ctx);
      case "download":
        return this.download(match.params.crate ?? "", match.params.version ?? "", ctx);
      case "yank":
        return this.setYank(match.params.crate ?? "", match.params.version ?? "", true, ctx);
      case "unyank":
        return this.setYank(match.params.crate ?? "", match.params.version ?? "", false, ctx);
      case "ownersList":
        return this.listOwners(match.params.crate ?? "", ctx);
      case "ownersAdd":
        return this.updateOwners(match.params.crate ?? "", req, "add", ctx);
      case "ownersRemove":
        return this.updateOwners(match.params.crate ?? "", req, "remove", ctx);
      case "index":
        return this.index(match.params.path ?? "", ctx);
      default:
        throw Errors.notFound();
    }
  }

  private findCrate(ctx: RegistryRequestContext, name: string) {
    return findPackageByName(ctx, name.toLowerCase());
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
    const vers = await listLivePackageVersions(pkg.id, { orderByCreated: "asc" });
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
    const v = await findLiveVersion(pkg.id, version);
    const digest = parseCargoVersionMeta(v?.metadata)?.crateDigest;
    if (!digest || !(await ctx.blobs.exists(digest))) throw Errors.notFound();
    return serveBlobIfClean(ctx, {
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
    const v = await findLiveVersion(pkg.id, version);
    if (!v) throw Errors.notFound();
    const meta = parseCargoVersionMeta(v.metadata);
    if (!meta) throw Errors.notFound();
    await updatePackageVersionMetadata(v.id, {
      ...meta,
      index: { ...meta.index, yanked },
    });
    return Response.json({ ok: true });
  }

  private async listOwners(crate: string, ctx: RegistryRequestContext): Promise<Response> {
    crate = parseCrateName(crate).toLowerCase();
    const pkg = await this.findCrate(ctx, crate);
    if (!pkg) throw Errors.notFound();
    const rows = await listLiveVersionPublishers(pkg.id);
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
