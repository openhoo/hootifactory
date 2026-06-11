import {
  Errors,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  registryAdapter,
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
class ScoopAdapterState {
  /** `GET /index.json` — `{<app>: {version}}` over live packages + their latest version. */
  async index(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const names = await ctx.data.packages.listNames();
    const index: Record<string, { version: string }> = {};
    // Deterministic ordering so the ETag is stable across requests.
    for (const { name } of [...names].sort((a, b) => a.name.localeCompare(b.name))) {
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
  async manifest(appRaw: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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
  async download(
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

  async publish(appRaw: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const app = parseAppName(appRaw);
    return handleScoopPublish(app, req, ctx);
  }

  /** Latest live version's stored metadata (versions ordered by creation). */
  async latestMeta(
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

/** App name a route param addresses, stripping the `.json` suffix on manifest reads. */
function scoopAppName(app: string | undefined, handlerId: string): string | null {
  if (!app) return null;
  const stripped =
    handlerId === "manifest" && app.toLowerCase().endsWith(".json")
      ? app.slice(0, -".json".length)
      : app;
  return isValidName(stripped) ? stripped : null;
}

const scoopDefinition = registryAdapter("scoop")
  .stateClass(ScoopAdapterState)
  .module((module) =>
    module
      .displayName("Scoop")
      .mount("scoop")
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("index", "manifest"),
  )
  .scan((scan) => scan.referencedDigestPaths("blobDigest"))
  .basicAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "filename",
        normalize: (filename, { match, params }) => {
          const app = scoopAppName(params.app, match.entry.handlerId);
          return app && params.version ? scoopBlobScope(app, params.version, filename) : null;
        },
        packageName: ({ match, params }) =>
          scoopAppName(params.app, match.entry.handlerId) ?? undefined,
      }),
      p.packageRule({
        param: "app",
        normalize: (app, { match }) => scoopAppName(app, match.entry.handlerId),
      }),
    ]),
  )
  .routes((route) => [
    // `/index.json` is a literal segment declared before `/:app` so it cannot be
    // shadowed by the app-manifest route (route-matcher tries routes in order).
    route.get("/index.json", "index").calls((state, { req, ctx }) => state.index(req, ctx)),
    route
      .get("/download/:app/:version/:filename", "download")
      .calls((state, { params, req, ctx }) =>
        state.download(params.app, params.version, params.filename, req, ctx),
      ),
    route
      .get("/:app", "manifest")
      .calls((state, { params, req, ctx }) => state.manifest(params.app, req, ctx)),
    route
      .put("/:app", "publish")
      .calls((state, { params, req, ctx }) => state.publish(params.app, req, ctx)),
  ]);

export class ScoopAdapter extends scoopDefinition.adapterClass() {}
export const scoopRegistryPlugin: RegistryPlugin = new ScoopAdapter();
