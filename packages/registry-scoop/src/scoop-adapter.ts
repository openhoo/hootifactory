import {
  basicAuthChallenge,
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
import { handleScoopPublish, scoopBlobScope } from "./scoop-publish-lifecycle";
import {
  buildScoopAppManifest,
  parseScoopVersionMeta,
  ScoopAppNameSchema,
  ScoopFilenameSchema,
  ScoopVersionSchema,
} from "./scoop-validation";

function parseAppName(app: string): string {
  return parseRegistryInput(ScoopAppNameSchema, app, {
    code: "NAME_INVALID",
    message: "invalid Scoop app name",
  });
}

function parseAppVersion(version: string): string {
  return parseRegistryInput(ScoopVersionSchema, version, {
    code: "MANIFEST_INVALID",
    message: "invalid Scoop version",
  });
}

/**
 * Scoop bucket. A repo's mount URL is added as a `scoop bucket`, and clients then
 * fetch JSON app manifests (`<app>.json`) plus a convenience `index.json`. Publish
 * is a hootifactory extension: real Scoop buckets are git repos PR'd by hand, so we
 * accept a `PUT /<app>` of the manifest + artifact and host the blob ourselves.
 */
export class ScoopAdapter implements RegistryPlugin {
  readonly id = "scoop" as const;
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Scoop",
      mountSegment: "scoop",
      errorResponseKind: "singleError",
      compressibleHandlers: ["index", "manifest"],
      scan: {
        defaultOsvEcosystem: undefined,
        referencedDigests: (metadata) =>
          typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // `/index.json` is a literal segment declared before `/:app` so it cannot be
      // shadowed by the app-manifest route (route-matcher tries routes in order).
      route.get("/index.json", "index", ({ req, ctx }) => this.index(req, ctx)),
      route.get("/download/:app/:version/:filename", "download", ({ params, req, ctx }) =>
        this.download(params.app, params.version, params.filename, req, ctx),
      ),
      route.get("/:app", "manifest", ({ params, req, ctx }) => this.manifest(params.app, req, ctx)),
      route.put("/:app", "publish", ({ params, req, ctx }) => this.publish(params.app, req, ctx)),
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
    const app = this.appFromMatch(match);
    const version = match?.params.version;
    const filename = match?.params.filename;
    if (app && version && filename && match?.entry?.handlerId === "download") {
      return {
        ...permission,
        resource: {
          type: "artifact",
          packageName: app,
          artifactRef: scoopBlobScope(app, version, filename),
        },
      };
    }
    if (app) {
      return { ...permission, resource: { type: "package", packageName: app } };
    }
    return permission;
  }

  handle = this.delegate.handle;

  /** Resolve the app name from a match, stripping the `.json` suffix on manifest reads. */
  private appFromMatch(match?: RouteMatch): string | null {
    const raw = match?.params.app;
    if (!raw) return null;
    const stripped =
      match?.entry?.handlerId === "manifest" && raw.toLowerCase().endsWith(".json")
        ? raw.slice(0, -".json".length)
        : raw;
    return isValidName(stripped) ? stripped : null;
  }

  /** `GET /index.json` — `{<app>: {version}}` over live packages + their latest version. */
  private async index(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const names = await ctx.data.packages.listNames();
    const index: Record<string, { version: string }> = {};
    // Deterministic ordering so the ETag is stable across requests.
    for (const { name } of [...names].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const pkg = await ctx.data.packages.findByName(name);
      if (!pkg) continue;
      const latest = await this.latestMeta(ctx, pkg);
      if (latest) index[name] = { version: latest.version };
    }
    return textResponseWithEtag(req, JSON.stringify(index), {
      "content-type": "application/json; charset=utf-8",
    });
  }

  /** `GET /<app>.json` — the app manifest assembled from the latest live version. */
  private async manifest(
    appRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    if (!appRaw.toLowerCase().endsWith(".json")) throw Errors.notFound();
    const app = parseAppName(appRaw.slice(0, -".json".length));
    const pkg = await ctx.data.packages.findByName(app);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const meta = await this.latestMeta(ctx, pkg);
    if (!meta) return new Response("Not Found", { status: 404 });
    const downloadUrl = `${ctx.baseUrl}/${ctx.repo.mountPath}/download/${encodeURIComponent(
      app,
    )}/${encodeURIComponent(meta.version)}/${encodeURIComponent(meta.filename)}`;
    return textResponseWithEtag(req, JSON.stringify(buildScoopAppManifest(meta, downloadUrl)), {
      "content-type": "application/json; charset=utf-8",
    });
  }

  /** `GET /download/<app>/<version>/<filename>` — serve the hosted artifact blob. */
  private async download(
    appRaw: string,
    versionRaw: string,
    filenameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const app = parseAppName(appRaw);
    const version = parseAppVersion(versionRaw);
    const filename = parseRegistryInput(ScoopFilenameSchema, filenameRaw, {
      code: "NAME_INVALID",
      message: "invalid artifact filename",
    });
    const pkg = await ctx.data.packages.findByName(app);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const row = await ctx.data.versions.findLive(pkg, version);
    const meta = parseScoopVersionMeta(row?.metadata);
    // The requested filename must match the canonical artifact this version stored.
    if (!meta || meta.filename !== filename) return new Response("Not Found", { status: 404 });
    return serveRegistryBlob(ctx, {
      digest: meta.blobDigest,
      kind: "scoop_artifact",
      scope: scoopBlobScope(app, version, filename),
      contentType: "application/octet-stream",
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  private async publish(
    appRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const app = parseAppName(appRaw);
    return handleScoopPublish(app, req, ctx);
  }

  /** Latest live version's stored metadata (versions ordered by creation). */
  private async latestMeta(
    ctx: RegistryRequestContext,
    pkg: { id: string; orgId: string; repositoryId: string; name: string },
  ) {
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "desc" });
    for (const row of rows) {
      const meta = parseScoopVersionMeta(row.metadata);
      if (meta) return meta;
    }
    return null;
  }
}

function isValidName(name: string): boolean {
  return ScoopAppNameSchema.safeParse(name).success;
}

export const scoopRegistryPlugin: RegistryPlugin = new ScoopAdapter();
