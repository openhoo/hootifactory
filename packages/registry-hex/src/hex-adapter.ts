import {
  createRegistryAdapterPlugin,
  jsonResponseWithEtag,
  type RegistryRequestContext,
  type RegistryRouteParamSpec,
  registryAdapter,
  registryErrorResponseForKind,
  serveVersionBlob,
} from "@hootifactory/registry";
import {
  buildHexApiPackage,
  buildHexApiRelease,
  buildHexNamesResource,
  buildHexPackageResource,
  type HexStoredRelease,
} from "./hex-metadata";
import { HEX_KIND, handleHexPublish, hexBlobScope } from "./hex-publish-lifecycle";
import {
  HexPackageNameSchema,
  HexTarballFilenameSchema,
  HexVersionSchema,
  parseHexVersionMeta,
  splitTarballFile,
} from "./hex-validation";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const nameParam: RegistryRouteParamSpec = {
  schema: HexPackageNameSchema,
  code: "NAME_INVALID",
  message: "invalid Hex package name",
};

const versionParam: RegistryRouteParamSpec = {
  schema: HexVersionSchema,
  code: "MANIFEST_INVALID",
  message: "invalid release version",
};

function jsonNotFound(message: string): Response {
  // Match the plugin's `singleError` envelope (`{ error }`) so 404s stay
  // consistent with publish errors and the registry error renderer.
  return registryErrorResponseForKind("singleError", { status: 404, message });
}

/**
 * Hex repository. Serves the repository resources Mix/`mix hex.*` resolve against
 * (`/names`, `/versions`, `/packages/:name`), the HTTP API package/release
 * metadata, the `/tarballs/<name>-<version>.tar` download, and `POST /api/publish`
 * (and `POST /publish`) which accepts a raw release tarball.
 *
 * Real Hex serves `/names`/`/versions`/`/packages/:name` as signed protobuf; this
 * hosted impl serves a documented JSON representation of the same data instead of
 * shipping a protobuf signer (see hex-metadata.ts for the JSON shapes).
 */
class HexAdapterState {
  /** Live releases for a package, oldest-first, with parsed metadata. */
  private async storedReleases(
    name: string,
    ctx: RegistryRequestContext,
  ): Promise<HexStoredRelease[] | null> {
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return null;
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" });
    return rows.flatMap((row) => {
      const meta = parseHexVersionMeta(row.metadata);
      return meta ? [{ version: row.version, meta }] : [];
    });
  }

  /** `GET /names` — every live package name (JSON; real Hex signs protobuf). */
  async names(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const names = await ctx.data.packages.listNames();
    const sorted = [...names].map((n) => n.name).sort((a, b) => a.localeCompare(b));
    return jsonResponseWithEtag(req, buildHexNamesResource(sorted), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  /** `GET /versions` — every live package's version list (JSON simplification). */
  async versions(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const names = await ctx.data.packages.listNames();
    const sorted = [...names].map((n) => n.name).sort((a, b) => a.localeCompare(b));
    const packages: { name: string; versions: string[] }[] = [];
    for (const name of sorted) {
      const releases = await this.storedReleases(name, ctx);
      if (releases && releases.length > 0) {
        packages.push({ name, versions: releases.map((r) => r.version) });
      }
    }
    return jsonResponseWithEtag(
      req,
      { packages },
      {
        "content-type": JSON_CONTENT_TYPE,
      },
    );
  }

  /** `GET /packages/:name` — the package's release list (JSON simplification). */
  async packageResource(
    name: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const releases = await this.storedReleases(name, ctx);
    if (!releases || releases.length === 0) return jsonNotFound(`package ${name} not found`);
    return jsonResponseWithEtag(
      req,
      buildHexPackageResource({ name, releases, repoName: ctx.repo.name }),
      { "content-type": JSON_CONTENT_TYPE },
    );
  }

  /** `GET /api/packages/:name` — HTTP API package metadata + release refs. */
  async apiPackage(name: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const releases = await this.storedReleases(name, ctx);
    if (!releases || releases.length === 0) return jsonNotFound(`package ${name} not found`);
    const body = buildHexApiPackage({
      name,
      releases,
      baseUrl: ctx.baseUrl,
      mountPath: ctx.repo.mountPath,
      repoName: ctx.repo.name,
    });
    return jsonResponseWithEtag(req, body, {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  /** `GET /api/packages/:name/releases/:version` — HTTP API single-release metadata. */
  async apiRelease(
    name: string,
    version: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return jsonNotFound(`package ${name} not found`);
    const row = await ctx.data.versions.findLive(pkg, version);
    const meta = parseHexVersionMeta(row?.metadata);
    if (!meta) return jsonNotFound(`release ${name} ${version} not found`);
    const body = buildHexApiRelease({
      name,
      version,
      meta,
      baseUrl: ctx.baseUrl,
      mountPath: ctx.repo.mountPath,
    });
    return jsonResponseWithEtag(req, body, {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  /** `GET /tarballs/<name>-<version>.tar` — serve the hosted release tarball blob. */
  async download(filename: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const split = splitTarballFile(filename);
    if (!split) return jsonNotFound("tarball not found");
    return serveVersionBlob(ctx, {
      name: split.name,
      version: split.version,
      kind: HEX_KIND,
      scope: hexBlobScope(split.name, split.version),
      parseMetadata: parseHexVersionMeta,
      digest: ({ metadata }) => metadata.blobDigest,
      contentType: "application/octet-stream",
      redirect: req.method === "GET",
      missing: () => jsonNotFound(`tarball ${filename} not found`),
    });
  }

  publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleHexPublish(req, ctx);
  }
}

function hexDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const parsed = parseHexVersionMeta(metadata);
  const reqs = parsed?.metadata.requirements;
  if (!reqs) return {};
  return Object.fromEntries(Object.entries(reqs).map(([name, req]) => [name, req.requirement]));
}

const hexDefinition = registryAdapter("hex")
  .stateClass(HexAdapterState)
  .module((module) =>
    module
      .displayName("Hex")
      .mount("hex")
      // Hex repos can be virtualized (the resolver-index convention shared with
      // rubygems/cargo/pub). They are NOT proxyable: this adapter implements no
      // `proxyIngest`, so advertising `proxyable` would be dishonest.
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("names", "versions", "packageResource", "apiPackage", "apiRelease"),
  )
  .scan({
    defaultOsvEcosystem: "Hex",
    dependencyGraph: ({ metadata }) => ({
      deps: hexDependencyGraph(metadata),
      osvEcosystem: "Hex",
      purlType: "hex",
    }),
    referencedDigests: (metadata) =>
      typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
  })
  // Hex authenticates with a bearer/bare token in the `authorization` header,
  // which the platform auth middleware handles directly; advertise a bearer
  // challenge for the 401 path.
  .registryBearerAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "filename",
        normalize: (filename) => {
          const split = splitTarballFile(filename);
          return split ? hexBlobScope(split.name, split.version) : null;
        },
        packageName: ({ params }) =>
          params.filename ? splitTarballFile(params.filename)?.name : undefined,
      }),
      p.packageRule({
        param: "name",
        normalize: (name) => (HexPackageNameSchema.safeParse(name).success ? name : null),
      }),
    ]),
  )
  .routes((route) => [
    // Publish: static routes declared before the `:name` catch-alls.
    route.post("/api/publish", "publish").calls((state, { req, ctx }) => state.publish(req, ctx)),
    route.post("/publish", "publish").calls((state, { req, ctx }) => state.publish(req, ctx)),
    // The canonical `mix hex.publish` endpoint: hex_core's
    // `hex_api_release:publish/3` POSTs the raw tarball to the path
    // `packages/<name>/releases` under the API base (with an optional
    // `?replace=...` query). The tarball's own metadata.config carries name +
    // version, so the `:name` path param is informational — declared ahead of
    // the GET-only `/api/packages/:name` route (method guard disambiguates).
    route
      .post("/api/packages/:name/releases", "publish")
      .calls((state, { req, ctx }) => state.publish(req, ctx)),
    // Repository resources (literal segments before `/packages/:name`).
    route.get("/names", "names").calls((state, { req, ctx }) => state.names(req, ctx)),
    route.get("/versions", "versions").calls((state, { req, ctx }) => state.versions(req, ctx)),
    // HTTP API: the `/releases/:version` route is more specific, so it precedes
    // the `/api/packages/:name` route in the (ordered) match table.
    route
      .get("/api/packages/:name/releases/:version", "apiRelease")
      .params({ name: nameParam, version: versionParam })
      .calls((state, { params, req, ctx }) =>
        state.apiRelease(params.name, params.version, req, ctx),
      ),
    route
      .get("/api/packages/:name", "apiPackage")
      .params({ name: nameParam })
      .calls((state, { params, req, ctx }) => state.apiPackage(params.name, req, ctx)),
    route
      .get("/tarballs/:filename", "download")
      .params({
        filename: {
          schema: HexTarballFilenameSchema,
          code: "NAME_INVALID",
          message: "invalid tarball filename",
        },
      })
      .calls((state, { params, req, ctx }) => state.download(params.filename, req, ctx)),
    route
      .get("/packages/:name", "packageResource")
      .params({ name: nameParam })
      .calls((state, { params, req, ctx }) => state.packageResource(params.name, req, ctx)),
  ]);

export class HexAdapter extends hexDefinition.adapterClass() {}
export const hexRegistryPlugin = createRegistryAdapterPlugin(HexAdapter);
