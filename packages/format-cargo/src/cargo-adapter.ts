import {
  createPackageVersion,
  Errors,
  type FormatAdapter,
  findOrCreatePackage,
  type HttpMethod,
  isArtifactBlocked,
  type Permission,
  parseRegistryInput,
  type RepoContext,
  type RouteEntry,
  type RouteMatch,
  releaseBlobRef,
  storeBlobWithRef,
} from "@hootifactory/core";
import { and, asc, eq, isNull, packages, packageVersions } from "@hootifactory/db";
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
} from "./cargo-validation";

/** Cargo sparse registry: config.json, sharded index, publish + download. */
export class CargoAdapter implements FormatAdapter {
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
      { method: "GET", pattern: "/:path+", handlerId: "index" },
    ];
  }

  requiredPermission(method: HttpMethod): Permission {
    return { action: method === "GET" || method === "HEAD" ? "read" : "write" };
  }

  authChallenge() {
    return { header: 'Bearer realm="hootifactory"', status: 401 as const };
  }

  async handle(match: RouteMatch, req: Request, ctx: RepoContext): Promise<Response> {
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
      case "index":
        return this.index(match.params.path ?? "", ctx);
      default:
        throw Errors.notFound();
    }
  }

  private async findCrate(ctx: RepoContext, name: string) {
    const [pkg] = await ctx.db
      .select()
      .from(packages)
      .where(and(eq(packages.repositoryId, ctx.repo.id), eq(packages.name, name.toLowerCase())))
      .limit(1);
    return pkg ?? null;
  }

  private async index(path: string, ctx: RepoContext): Promise<Response> {
    path = parseRegistryInput(CargoIndexPathSchema, path, {
      code: "NAME_INVALID",
      message: "invalid cargo index path",
    });
    const name = (path.split("/").pop() ?? "").toLowerCase();
    // The request path must equal the canonical sparse-index shard for the crate.
    if (path !== cargoIndexPath(name)) return new Response("", { status: 404 });
    const pkg = await this.findCrate(ctx, name);
    if (!pkg) return new Response("", { status: 404 });
    const vers = await ctx.db
      .select({ metadata: packageVersions.metadata })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, pkg.id), isNull(packageVersions.deletedAt)))
      .orderBy(asc(packageVersions.createdAt));
    const lines = vers
      .map((v) => JSON.stringify((v.metadata as unknown as CargoVersionMeta).index))
      .join("\n");
    return new Response(`${lines}\n`, { headers: { "content-type": "text/plain" } });
  }

  private async download(crate: string, version: string, ctx: RepoContext): Promise<Response> {
    crate = parseRegistryInput(CargoCrateNameSchema, crate, {
      code: "NAME_INVALID",
      message: "invalid crate name",
    });
    version = parseRegistryInput(CargoVersionSchema, version, {
      code: "MANIFEST_INVALID",
      message: "invalid crate version",
    });
    const pkg = await this.findCrate(ctx, crate);
    if (!pkg) throw Errors.notFound();
    const [v] = await ctx.db
      .select({ metadata: packageVersions.metadata })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, pkg.id),
          eq(packageVersions.version, version),
          isNull(packageVersions.deletedAt),
        ),
      )
      .limit(1);
    const digest = (v?.metadata as unknown as CargoVersionMeta | undefined)?.crateDigest;
    if (!digest || !(await ctx.blobs.exists(digest))) throw Errors.notFound();
    if (await isArtifactBlocked(ctx, digest)) {
      return new Response("blocked by scan policy", { status: 403 });
    }
    return new Response(ctx.blobs.get(digest), {
      headers: { "content-type": "application/octet-stream" },
    });
  }

  /** Toggle the yanked flag in a crate version's stored index entry. */
  private async setYank(
    crate: string,
    version: string,
    yanked: boolean,
    ctx: RepoContext,
  ): Promise<Response> {
    crate = parseRegistryInput(CargoCrateNameSchema, crate, {
      code: "NAME_INVALID",
      message: "invalid crate name",
    });
    version = parseRegistryInput(CargoVersionSchema, version, {
      code: "MANIFEST_INVALID",
      message: "invalid crate version",
    });
    const pkg = await this.findCrate(ctx, crate);
    if (!pkg) throw Errors.notFound();
    const [v] = await ctx.db
      .select({ id: packageVersions.id, metadata: packageVersions.metadata })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, pkg.id),
          eq(packageVersions.version, version),
          isNull(packageVersions.deletedAt),
        ),
      )
      .limit(1);
    if (!v) throw Errors.notFound();
    const meta = (v.metadata ?? {}) as { index?: Record<string, unknown> };
    await ctx.db
      .update(packageVersions)
      .set({ metadata: { ...meta, index: { ...(meta.index ?? {}), yanked } } })
      .where(eq(packageVersions.id, v.id));
    return Response.json({ ok: true });
  }

  private async publish(req: Request, ctx: RepoContext): Promise<Response> {
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
    const [existing] = await ctx.db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, meta.vers)))
      .limit(1);
    if (existing) return Response.json({ error: "version already exists" }, { status: 409 });

    const stored = await storeBlobWithRef(ctx, {
      data: crateBytes,
      kind: "generic_file",
      scope,
      mediaType: "application/octet-stream",
    });
    const indexEntry = buildCargoIndexEntry(meta, cksum);
    const versionId = await createPackageVersion(ctx, {
      packageId: pkg.id,
      version: meta.vers,
      metadata: { index: indexEntry, crateDigest: stored.digest },
      sizeBytes: crateBytes.length,
    });
    if (!versionId) {
      if (stored.refCreated) {
        await releaseBlobRef(ctx, {
          digest: stored.digest,
          kind: "generic_file",
          scope,
        });
      }
      return Response.json({ error: "version already exists" }, { status: 409 });
    }
    await ctx.enqueueScan({
      digest: stored.digest,
      name,
      version: meta.vers,
      mediaType: "application/octet-stream",
    });
    return Response.json({ warnings: { invalid_categories: [], invalid_badges: [], other: [] } });
  }
}
