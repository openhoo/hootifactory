import {
  Errors,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  registryAdapter,
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
class CargoAdapterState {
  findCrate(ctx: RegistryRequestContext, name: string) {
    return ctx.data.packages.findByName(name.toLowerCase());
  }

  async index(path: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

  async download(
    crate: string,
    version: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    // The sparse index advertises the original-case crate name, so cargo requests
    // the download with that casing. Publish stores both the package record and the
    // blob scope lowercased, so we must canonicalize here to match (see #219).
    const lower = parseCrateName(crate).toLowerCase();
    version = parseCrateVersion(version);
    const pkg = await this.findCrate(ctx, lower);
    if (!pkg) throw Errors.notFound();
    const v = await ctx.data.versions.findLive(pkg, version);
    const digest = parseCargoVersionMeta(v?.metadata)?.crateDigest;
    if (!digest) throw Errors.notFound();
    return serveRegistryBlob(ctx, {
      digest,
      kind: "generic_file",
      scope: cargoBlobScope(lower, version),
      contentType: "application/octet-stream",
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  /** Toggle the yanked flag in a crate version's stored index entry. */
  async setYank(
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

  async listOwners(crate: string, ctx: RegistryRequestContext): Promise<Response> {
    crate = parseCrateName(crate).toLowerCase();
    const pkg = await this.findCrate(ctx, crate);
    if (!pkg) throw Errors.notFound();
    const rows = await ctx.data.versions.listPublishers(pkg);
    return Response.json(buildCargoOwnersBody(rows));
  }

  async updateOwners(
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

  async publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleCargoPublish(req, ctx);
  }
}

function cargoDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const parsed = parseCargoVersionMeta(metadata);
  if (!parsed) return {};
  return Object.fromEntries(parsed.index.deps.map((dep) => [dep.name, dep.req]));
}

const cargoDefinition = registryAdapter("cargo")
  .stateClass(CargoAdapterState)
  .module((module) =>
    module
      .displayName("Cargo")
      .mount("cargo")
      .capabilities("virtualizable")
      .errorResponseKind("errorsDetail")
      .compressibleHandlers("config", "index", "ownersList"),
  )
  .scan((scan) =>
    scan
      .osvEcosystem("crates.io")
      .purlType("cargo")
      .dependencies(cargoDependencyGraph)
      .referencedDigestPaths("crateDigest"),
  )
  .bearerAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "version",
        normalize: (version, { match, params }) =>
          match.entry.handlerId === "download" && params.crate ? version : null,
        packageName: ({ params }) => params.crate?.toLowerCase(),
        artifactRef: (version, { params }) =>
          params.crate ? cargoBlobScope(params.crate.toLowerCase(), version) : null,
      }),
      p.packageRule({ param: "crate", normalize: (crate) => crate.toLowerCase() }),
    ]),
  )
  .routes((route) => [
    route.get("/config.json", "config").json(({ ctx }) => ({
      dl: `${ctx.baseUrl}/${ctx.repo.mountPath}/api/v1/crates`,
      api: `${ctx.baseUrl}/${ctx.repo.mountPath}`,
    })),
    route
      .put("/api/v1/crates/new", "publish")
      .calls((state, { req, ctx }) => state.publish(req, ctx)),
    route
      .get("/api/v1/crates/:crate/:version/download", "download")
      .calls((state, { params, req, ctx }) =>
        state.download(params.crate, params.version, req, ctx),
      ),
    route
      .delete("/api/v1/crates/:crate/:version/yank", "yank")
      .calls((state, { params, ctx }) => state.setYank(params.crate, params.version, true, ctx)),
    route
      .put("/api/v1/crates/:crate/:version/unyank", "unyank")
      .calls((state, { params, ctx }) => state.setYank(params.crate, params.version, false, ctx)),
    route
      .get("/api/v1/crates/:crate/owners", "ownersList")
      .calls((state, { params, ctx }) => state.listOwners(params.crate, ctx)),
    route
      .put("/api/v1/crates/:crate/owners", "ownersAdd")
      .calls((state, { params, req, ctx }) => state.updateOwners(params.crate, req, "add", ctx)),
    route
      .delete("/api/v1/crates/:crate/owners", "ownersRemove")
      .calls((state, { params, req, ctx }) => state.updateOwners(params.crate, req, "remove", ctx)),
    route
      .get("/:path+", "index")
      .calls((state, { params, req, ctx }) => state.index(params.path, req, ctx)),
  ]);

export class CargoAdapter extends cargoDefinition.adapterClass() {}
export const cargoRegistryPlugin: RegistryPlugin = new CargoAdapter();
