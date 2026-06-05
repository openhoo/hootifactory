import {
  bearerAuthChallenge,
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  RegistryError,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { handleSwiftPublish } from "./swift-publish-lifecycle";
import {
  parseSwiftVersionMeta,
  readSwiftClientMetadata,
  SwiftNameSchema,
  SwiftScopeSchema,
  SwiftVersionSchema,
  swiftArchiveScope,
  swiftPackageId,
  swiftPermissionName,
} from "./swift-validation";

const CONTENT_VERSION = "1";
// SE-0292 JSON endpoints respond with plain `application/json`; the vendored
// `application/vnd.swift.registry.v1+json` media type is the request Accept
// value, and the protocol version is carried by the `Content-Version` header.
const JSON_CONTENT_TYPE = "application/json";
const MANIFEST_CONTENT_TYPE = "text/x-swift";

/** Stamp the SE-0292 `Content-Version` header onto every response. */
function withContentVersion(res: Response): Response {
  if (!res.headers.has("content-version")) res.headers.set("content-version", CONTENT_VERSION);
  return res;
}

/** Render a thrown protocol error as RFC 7807 `application/problem+json`. */
function problemResponse(status: number, detail: string): Response {
  return new Response(JSON.stringify({ status, detail }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

function parseScope(scope: string): string {
  return parseRegistryInput(SwiftScopeSchema, scope, {
    code: "NAME_INVALID",
    message: "invalid package scope",
  });
}

function parseName(name: string): string {
  return parseRegistryInput(SwiftNameSchema, name, {
    code: "NAME_INVALID",
    message: "invalid package name",
  });
}

function parseVersion(version: string): string {
  return parseRegistryInput(SwiftVersionSchema, version, {
    code: "MANIFEST_INVALID",
    message: "invalid package version",
  });
}

/** Swift Package Registry (SE-0292): the protocol SwiftPM speaks. */
export class SwiftAdapter implements RegistryPlugin {
  readonly id = "swift" as const;
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = () => bearerAuthChallenge();

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Swift",
      mountSegment: "swift",
      errorResponseKind: "singleError",
      compressibleHandlers: ["releases", "release", "manifest", "identifiers"],
      compressibleContentTypes: [JSON_CONTENT_TYPE, MANIFEST_CONTENT_TYPE],
      scan: {
        defaultOsvEcosystem: "SwiftURL",
        dependencyGraph: () => ({ deps: {}, purlType: "swift" }),
        referencedDigests: (metadata) => {
          const meta = parseSwiftVersionMeta(metadata);
          return meta ? [meta.archiveDigest] : [];
        },
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      route.get("/identifiers", "identifiers", ({ req, ctx }) => this.identifiers(req, ctx)),
      route.get("/:scope/:name", "releases", ({ params, req, ctx }) =>
        this.releases(params.scope, params.name, req, ctx),
      ),
      // Declared before `/:scope/:name/:ref` so the manifest path wins.
      route.get("/:scope/:name/:version/Package.swift", "manifest", ({ params, req, ctx }) =>
        this.manifest(params.scope, params.name, params.version, req, ctx),
      ),
      route.get("/:scope/:name/:ref", "release", ({ params, req, ctx }) =>
        this.release(params.scope, params.name, params.ref, req, ctx),
      ),
      route.put("/:scope/:name/:version", "publish", ({ params, req, ctx }) =>
        this.publish(params.scope, params.name, params.version, req, ctx),
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
    const scope = match?.params.scope;
    const name = match?.params.name;
    if (!scope || !name) return permission;
    const packageName = swiftPermissionName(scope, name);
    const ref = match?.params.ref;
    if (ref?.endsWith(".zip")) {
      return {
        ...permission,
        resource: {
          type: "artifact",
          packageName,
          artifactRef: swiftArchiveScope(scope, name, ref.slice(0, -".zip".length)),
        },
      };
    }
    return { ...permission, resource: { type: "package", packageName } };
  }

  handle = async (
    match: RouteMatch,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> => {
    try {
      return withContentVersion(await this.delegate.handle(match, req, ctx));
    } catch (err) {
      // Render thrown protocol errors here (not via the platform's generic
      // `errorResponseKind` path) so every error is a SE-0292 `Content-Version`
      // RFC 7807 `application/problem+json` body, consistent with publish/identifiers.
      if (err instanceof RegistryError) {
        return withContentVersion(problemResponse(err.status, err.message));
      }
      return withContentVersion(problemResponse(500, "internal server error"));
    }
  };

  private async findPackage(ctx: RegistryRequestContext, scope: string, name: string) {
    return ctx.data.packages.findByName(swiftPackageId(scope, name));
  }

  /** GET /:scope/:name — list the live releases of a package. */
  private async releases(
    scopeRaw: string,
    nameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const scope = parseScope(scopeRaw);
    const name = parseName(nameRaw);
    const pkg = await this.findPackage(ctx, scope, name);
    if (!pkg) throw Errors.notFound();
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "desc" });
    const base = `${ctx.baseUrl}/${ctx.repo.mountPath}/${scope}/${name}`;
    const releases: Record<string, { url: string }> = {};
    for (const row of rows) releases[row.version] = { url: `${base}/${row.version}` };
    return textResponseWithEtag(req, JSON.stringify({ releases }), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  /**
   * GET /:scope/:name/:ref — either serve the `.zip` source archive, or return
   * release metadata for a version reference.
   */
  private async release(
    scopeRaw: string,
    nameRaw: string,
    ref: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const scope = parseScope(scopeRaw);
    const name = parseName(nameRaw);
    if (ref.endsWith(".zip")) {
      return this.downloadArchive(scope, name, ref.slice(0, -".zip".length), req, ctx);
    }
    return this.releaseMetadata(scope, name, parseVersion(ref), req, ctx);
  }

  private async releaseMetadata(
    scope: string,
    name: string,
    version: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = await this.findPackage(ctx, scope, name);
    if (!pkg) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkg, version);
    const meta = parseSwiftVersionMeta(row?.metadata);
    if (!row || !meta) throw Errors.notFound();
    const base = `${ctx.baseUrl}/${ctx.repo.mountPath}/${scope}/${name}`;
    const body = {
      id: swiftPackageId(scope, name),
      version,
      resources: [
        {
          name: "source-archive",
          type: "application/zip",
          checksum: meta.checksum,
        },
      ],
      metadata: meta.metadata,
      publishedAt: row.createdAt.toISOString(),
      _links: {
        latest: { url: base },
        "source-archive": { url: `${base}/${version}.zip` },
      },
    };
    return textResponseWithEtag(req, JSON.stringify(body), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  private async downloadArchive(
    scope: string,
    name: string,
    versionRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const version = parseVersion(versionRaw);
    const pkg = await this.findPackage(ctx, scope, name);
    if (!pkg) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkg, version);
    const meta = parseSwiftVersionMeta(row?.metadata);
    if (!meta) throw Errors.notFound();
    const checksumBase64 = Buffer.from(meta.checksum, "hex").toString("base64");
    return serveRegistryBlob(ctx, {
      digest: meta.archiveDigest,
      kind: "swift_archive",
      scope: swiftArchiveScope(scope, name, version),
      contentType: "application/zip",
      extraHeaders: {
        "content-disposition": `attachment; filename="${name}-${version}.zip"`,
        digest: `sha-256=${checksumBase64}`,
        "content-version": CONTENT_VERSION,
      },
      redirect: req.method === "GET",
      blocked: () => problemResponse(403, "blocked by scan policy"),
    });
  }

  /** GET /:scope/:name/:version/Package.swift — the package manifest text. */
  private async manifest(
    scopeRaw: string,
    nameRaw: string,
    versionRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const scope = parseScope(scopeRaw);
    const name = parseName(nameRaw);
    const version = parseVersion(versionRaw);
    const pkg = await this.findPackage(ctx, scope, name);
    if (!pkg) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkg, version);
    const meta = parseSwiftVersionMeta(row?.metadata);
    if (!meta) throw Errors.notFound();
    const text = meta.manifest ?? "// swift-tools-version:5.0\n";
    return textResponseWithEtag(req, text, {
      "content-type": MANIFEST_CONTENT_TYPE,
      "content-disposition": 'attachment; filename="Package.swift"',
    });
  }

  /** PUT /:scope/:name/:version — publish a release. */
  private async publish(
    scopeRaw: string,
    nameRaw: string,
    versionRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const scope = parseScope(scopeRaw);
    const name = parseName(nameRaw);
    const version = parseVersion(versionRaw);
    const result = await handleSwiftPublish(scope, name, version, req, ctx);
    if (result.status === 201) {
      return new Response(null, {
        status: 201,
        headers: {
          location: result.location ?? "",
          ...(result.checksum ? { "swift-package-digest": result.checksum } : {}),
        },
      });
    }
    return this.problem(result.status, result.detail ?? "publish failed");
  }

  /** GET /identifiers?url=... — map a repository URL to package identifiers. */
  private async identifiers(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const url = new URL(req.url).searchParams.get("url");
    if (!url) return this.problem(400, "missing url query parameter");
    const rows = await ctx.data.packages.list();
    const identifiers: string[] = [];
    for (const row of rows) {
      const meta = await this.matchesRepositoryUrl(ctx, row, url);
      if (meta) identifiers.push(row.name);
    }
    if (identifiers.length === 0) throw Errors.notFound();
    return new Response(JSON.stringify({ identifiers }), {
      headers: { "content-type": JSON_CONTENT_TYPE },
    });
  }

  private async matchesRepositoryUrl(
    ctx: RegistryRequestContext,
    row: { id: string; orgId: string; repositoryId: string; name: string },
    url: string,
  ): Promise<boolean> {
    const versions = await ctx.data.versions.listLive(row, { orderByCreated: "desc" });
    for (const version of versions) {
      const client = readSwiftClientMetadata(version.metadata);
      const repoURL = (client.repositoryURLs ?? client.repositoryURL) as unknown;
      if (typeof repoURL === "string" && repoURL === url) return true;
      if (Array.isArray(repoURL) && repoURL.includes(url)) return true;
    }
    return false;
  }

  /** Build an RFC 7807 `application/problem+json` body. */
  private problem(status: number, detail: string): Response {
    return problemResponse(status, detail);
  }
}

export const swiftRegistryPlugin: RegistryPlugin = new SwiftAdapter();
