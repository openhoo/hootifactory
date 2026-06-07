import {
  delegateRegistryPlugin,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryBearerAuthChallenge,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
  textResponseWithEtag,
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

function parseHexName(name: string): string {
  return parseRegistryInput(HexPackageNameSchema, name, {
    code: "NAME_INVALID",
    message: "invalid Hex package name",
  });
}

function parseHexVersion(version: string): string {
  return parseRegistryInput(HexVersionSchema, version, {
    code: "MANIFEST_INVALID",
    message: "invalid release version",
  });
}

function jsonNotFound(message: string): Response {
  return Response.json({ message }, { status: 404 });
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
export class HexAdapter implements RegistryPlugin {
  readonly id = "hex" as const;
  readonly capabilities = registryCapabilities("proxyable", "virtualizable");
  // Hex uses an `authorization` api-key header; advertise a bearer challenge.
  authChallenge = (permission: Permission, ctx: RegistryRequestContext) =>
    registryBearerAuthChallenge({ ctx, permission });

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Hex",
      mountSegment: "hex",
      errorResponseKind: "singleError",
      apiKeyHeaders: ["authorization"],
      compressibleHandlers: ["names", "versions", "packageResource", "apiPackage", "apiRelease"],
      scan: {
        defaultOsvEcosystem: "Hex",
        dependencyGraph: ({ metadata }) => ({
          deps: hexDependencyGraph(metadata),
          osvEcosystem: "Hex",
          purlType: "hex",
        }),
        referencedDigests: (metadata) =>
          typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // Publish: static routes declared before the `:name` catch-alls.
      route.post("/api/publish", "publish", ({ req, ctx }) => this.publish(req, ctx)),
      route.post("/publish", "publish", ({ req, ctx }) => this.publish(req, ctx)),
      // Repository resources (literal segments before `/packages/:name`).
      route.get("/names", "names", ({ req, ctx }) => this.names(req, ctx)),
      route.get("/versions", "versions", ({ req, ctx }) => this.versions(req, ctx)),
      // HTTP API: the `/releases/:version` route is more specific, so it precedes
      // the `/api/packages/:name` route in the (ordered) match table.
      route.get("/api/packages/:name/releases/:version", "apiRelease", ({ params, req, ctx }) =>
        this.apiRelease(params.name, params.version, req, ctx),
      ),
      route.get("/api/packages/:name", "apiPackage", ({ params, req, ctx }) =>
        this.apiPackage(params.name, req, ctx),
      ),
      route.get("/tarballs/:filename", "download", ({ params, req, ctx }) =>
        this.download(params.filename, req, ctx),
      ),
      route.get("/packages/:name", "packageResource", ({ params, req, ctx }) =>
        this.packageResource(params.name, req, ctx),
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

  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    const permission = readWritePermission(method);
    const name = match?.params.name;
    const filename = match?.params.filename;
    if (filename) {
      const split = splitTarballFile(filename);
      if (split) {
        return {
          ...permission,
          resource: {
            type: "artifact",
            packageName: split.name,
            artifactRef: hexBlobScope(split.name, split.version),
          },
        };
      }
    }
    if (name && HexPackageNameSchema.safeParse(name).success) {
      return { ...permission, resource: { type: "package", packageName: name } };
    }
    return permission;
  }

  handle = this.delegate.handle;

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
  private async names(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const names = await ctx.data.packages.listNames();
    const sorted = [...names].map((n) => n.name).sort((a, b) => a.localeCompare(b));
    return textResponseWithEtag(req, JSON.stringify(buildHexNamesResource(sorted)), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  /** `GET /versions` — every live package's version list (JSON simplification). */
  private async versions(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const names = await ctx.data.packages.listNames();
    const sorted = [...names].map((n) => n.name).sort((a, b) => a.localeCompare(b));
    const packages: { name: string; versions: string[] }[] = [];
    for (const name of sorted) {
      const releases = await this.storedReleases(name, ctx);
      if (releases && releases.length > 0) {
        packages.push({ name, versions: releases.map((r) => r.version) });
      }
    }
    return textResponseWithEtag(req, JSON.stringify({ packages }), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  /** `GET /packages/:name` — the package's release list (JSON simplification). */
  private async packageResource(
    nameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const name = parseHexName(nameRaw);
    const releases = await this.storedReleases(name, ctx);
    if (!releases || releases.length === 0) return jsonNotFound(`package ${name} not found`);
    return textResponseWithEtag(
      req,
      JSON.stringify(buildHexPackageResource({ name, releases, repoName: ctx.repo.name })),
      { "content-type": JSON_CONTENT_TYPE },
    );
  }

  /** `GET /api/packages/:name` — HTTP API package metadata + release refs. */
  private async apiPackage(
    nameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const name = parseHexName(nameRaw);
    const releases = await this.storedReleases(name, ctx);
    if (!releases || releases.length === 0) return jsonNotFound(`package ${name} not found`);
    const body = buildHexApiPackage({
      name,
      releases,
      baseUrl: ctx.baseUrl,
      mountPath: ctx.repo.mountPath,
      repoName: ctx.repo.name,
    });
    return textResponseWithEtag(req, JSON.stringify(body), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  /** `GET /api/packages/:name/releases/:version` — HTTP API single-release metadata. */
  private async apiRelease(
    nameRaw: string,
    versionRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const name = parseHexName(nameRaw);
    const version = parseHexVersion(versionRaw);
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
    return textResponseWithEtag(req, JSON.stringify(body), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  /** `GET /tarballs/<name>-<version>.tar` — serve the hosted release tarball blob. */
  private async download(
    filenameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const filename = parseRegistryInput(HexTarballFilenameSchema, filenameRaw, {
      code: "NAME_INVALID",
      message: "invalid tarball filename",
    });
    const split = splitTarballFile(filename);
    if (!split) return jsonNotFound("tarball not found");
    const pkg = await ctx.data.packages.findByName(split.name);
    if (!pkg) return jsonNotFound(`tarball ${filename} not found`);
    const row = await ctx.data.versions.findLive(pkg, split.version);
    const meta = parseHexVersionMeta(row?.metadata);
    if (!meta) return jsonNotFound(`tarball ${filename} not found`);
    return serveRegistryBlob(ctx, {
      digest: meta.blobDigest,
      kind: HEX_KIND,
      scope: hexBlobScope(split.name, split.version),
      contentType: "application/octet-stream",
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  private publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleHexPublish(req, ctx);
  }
}

function hexDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const parsed = parseHexVersionMeta(metadata);
  const reqs = parsed?.metadata.requirements;
  if (!reqs) return {};
  return Object.fromEntries(Object.entries(reqs).map(([name, range]) => [name, String(range)]));
}

export const hexRegistryPlugin: RegistryPlugin = new HexAdapter();
