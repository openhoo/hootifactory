import {
  createRegistryAdapterPlugin,
  Errors,
  type RegistryRequestContext,
  type RegistryRouteParamSpec,
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

const crateParam: RegistryRouteParamSpec = {
  schema: CargoCrateNameSchema,
  code: "NAME_INVALID",
  message: "invalid crate name",
};

const versionParam: RegistryRouteParamSpec = {
  schema: CargoVersionSchema,
  code: "MANIFEST_INVALID",
  message: "invalid crate version",
};

/** Cargo sparse registry: config.json, sharded index, publish + download. */
class CargoAdapterState {
  findCrate(ctx: RegistryRequestContext, name: string) {
    return ctx.data.packages.findByName(name.toLowerCase());
  }

  async index(path: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const name = (path.split("/").pop() ?? "").toLowerCase();
    // The request path must equal the canonical sparse-index shard for the crate.
    if (path !== cargoIndexPath(name)) throw Errors.notFound();
    const pkg = await this.findCrate(ctx, name);
    if (!pkg) throw Errors.notFound();
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
    _req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    // The sparse index advertises the original-case crate name, so cargo requests
    // the download with that casing. Publish stores both the package record and the
    // blob scope lowercased, so we must canonicalize here to match (see #219).
    const lower = crate.toLowerCase();
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
    crate = crate.toLowerCase();
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
    crate = crate.toLowerCase();
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
      .params({ crate: crateParam, version: versionParam })
      .calls((state, { params, req, ctx }) =>
        state.download(params.crate, params.version, req, ctx),
      ),
    route
      .delete("/api/v1/crates/:crate/:version/yank", "yank")
      .params({ crate: crateParam, version: versionParam })
      .calls((state, { params, ctx }) => state.setYank(params.crate, params.version, true, ctx)),
    route
      .put("/api/v1/crates/:crate/:version/unyank", "unyank")
      .params({ crate: crateParam, version: versionParam })
      .calls((state, { params, ctx }) => state.setYank(params.crate, params.version, false, ctx)),
    route
      .get("/api/v1/crates/:crate/owners", "ownersList")
      .params({ crate: crateParam })
      .calls((state, { params, ctx }) => state.listOwners(params.crate, ctx)),
    route
      .put("/api/v1/crates/:crate/owners", "ownersAdd")
      .params({ crate: crateParam })
      .calls((state, { params, req, ctx }) => state.updateOwners(params.crate, req, "add", ctx)),
    route
      .delete("/api/v1/crates/:crate/owners", "ownersRemove")
      .params({ crate: crateParam })
      .calls((state, { params, req, ctx }) => state.updateOwners(params.crate, req, "remove", ctx)),
    route
      .get("/:path+", "index")
      .params({
        path: {
          schema: CargoIndexPathSchema,
          code: "NAME_INVALID",
          message: "invalid cargo index path",
        },
      })
      .calls((state, { params, req, ctx }) => state.index(params.path, req, ctx)),
  ]);

export class CargoAdapter extends cargoDefinition.adapterClass() {}
export const cargoRegistryPlugin = createRegistryAdapterPlugin(CargoAdapter);
