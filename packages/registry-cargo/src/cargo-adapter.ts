import { and, asc, eq, isNull, packageVersions, users } from "@hootifactory/db";
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
  commitVersionOrReleaseBlob,
  findLiveVersion,
  findOrCreatePackage,
  findPackageByName,
  serveBlobIfClean,
  storeBlobWithRef,
} from "@hootifactory/registry-application";
import {
  buildCargoOwnersBody,
  buildCargoOwnersUpdateBody,
  type CargoOwnerRow,
  parseCargoOwnersRequest,
} from "./cargo-owners";
import {
  buildCargoIndexEntry,
  cargoBlobScope,
  digestCargoCrate,
  parseCargoPublishBody,
} from "./cargo-publish";
import {
  CargoCrateNameSchema,
  CargoIndexPathSchema,
  type CargoVersionMeta,
  CargoVersionSchema,
  cargoIndexPath,
  cargoVersionIdentity,
} from "./cargo-validation";

function cargoError(detail: string, status: number): Response {
  return Response.json({ errors: [{ detail }] }, { status });
}

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

type CargoIndexRow = { metadata: unknown };
type CargoExistingVersionRow = { version: string };

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
    const vers = (await ctx.db
      .select({ metadata: packageVersions.metadata })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, pkg.id), isNull(packageVersions.deletedAt)))
      .orderBy(asc(packageVersions.createdAt))) as CargoIndexRow[];
    const lines = vers
      .map((v) => JSON.stringify((v.metadata as unknown as CargoVersionMeta).index))
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
    const v = await findLiveVersion(ctx, pkg.id, version);
    const digest = (v?.metadata as unknown as CargoVersionMeta | undefined)?.crateDigest;
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
    const v = await findLiveVersion(ctx, pkg.id, version);
    if (!v) throw Errors.notFound();
    const meta = (v.metadata ?? {}) as { index?: Record<string, unknown> };
    await ctx.db
      .update(packageVersions)
      .set({ metadata: { ...meta, index: { ...(meta.index ?? {}), yanked } } })
      .where(eq(packageVersions.id, v.id));
    return Response.json({ ok: true });
  }

  private async listOwners(crate: string, ctx: RegistryRequestContext): Promise<Response> {
    crate = parseCrateName(crate).toLowerCase();
    const pkg = await this.findCrate(ctx, crate);
    if (!pkg) throw Errors.notFound();
    const rows = (await ctx.db
      .select({
        id: users.id,
        login: users.username,
        name: users.displayName,
      })
      .from(packageVersions)
      .innerJoin(users, eq(packageVersions.publishedByUserId, users.id))
      .where(and(eq(packageVersions.packageId, pkg.id), isNull(packageVersions.deletedAt)))
      .orderBy(asc(packageVersions.createdAt))) as CargoOwnerRow[];
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
    const { metadata: meta, crateBytes } = parseCargoPublishBody(
      new Uint8Array(await req.arrayBuffer()),
    );

    const name = meta.name.toLowerCase();
    const cksum = digestCargoCrate(crateBytes);
    const scope = cargoBlobScope(name, meta.vers);
    const pkg = await findOrCreatePackage({
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name,
    });
    const existingVersions = (await ctx.db
      .select({ version: packageVersions.version })
      .from(packageVersions)
      .where(eq(packageVersions.packageId, pkg.id))) as CargoExistingVersionRow[];
    if (
      existingVersions.some(
        (version) => cargoVersionIdentity(version.version) === cargoVersionIdentity(meta.vers),
      )
    ) {
      return cargoError("version already exists", 409);
    }

    const stored = await storeBlobWithRef(ctx, {
      data: crateBytes,
      kind: "generic_file",
      scope,
      mediaType: "application/octet-stream",
    });
    const indexEntry = buildCargoIndexEntry(meta, cksum);
    const result = await commitVersionOrReleaseBlob(ctx, {
      stored,
      kind: "generic_file",
      scope,
      packageId: pkg.id,
      version: meta.vers,
      metadata: { index: indexEntry, crateDigest: stored.digest },
      sizeBytes: crateBytes.length,
      scan: {
        name,
        version: meta.vers,
        mediaType: "application/octet-stream",
      },
    });
    if ("conflict" in result) {
      return cargoError("version already exists", 409);
    }
    return Response.json({ warnings: { invalid_categories: [], invalid_badges: [], other: [] } });
  }
}
