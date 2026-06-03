import {
  basicAuthChallenge,
  defineRegistryPlugin,
  delegateRegistryPlugin,
  type FormatMetadata,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPackageHandle,
  type RegistryPackageVersionRow,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  registryRoutes,
  type SearchQuery,
  type SearchResult,
  serveRegistryBlob,
} from "@hootifactory/registry";
import { parseNpmDistTag, parseNpmDistTagRequestBody } from "./npm-dist-tags";
import { ifNoneMatch } from "./npm-http";
import { type NpmDist, sha1hexText } from "./npm-integrity";
import { handleNpmProxyIngest } from "./npm-proxy-lifecycle";
import { handleNpmPublish } from "./npm-publish-lifecycle";
import {
  buildNpmSearchObject,
  buildNpmSearchResponse,
  type NpmSearchObject,
  parseNpmSearchQuery,
} from "./npm-search";
import {
  NpmLegacyPackageNameSchema,
  NpmTarballFilenameSchema,
  parseNpmStoredVersionMetadata,
} from "./npm-validation";
import { buildPackument, mergePackuments } from "./packument";

function parseNpmName(name: string): string {
  return parseRegistryInput(NpmLegacyPackageNameSchema, name, {
    code: "NAME_INVALID",
    message: "invalid package name",
  });
}

export class NpmAdapter implements RegistryPlugin {
  readonly format = "npm" as const;
  readonly capabilities = {
    contentAddressable: false,
    resumableUploads: false,
    proxyable: true,
    virtualizable: true,
  };
  authChallenge = basicAuthChallenge;

  private readonly plugin = defineRegistryPlugin({
    format: this.format,
    capabilities: this.capabilities,
    authChallenge: this.authChallenge,
    defaultPermission: ({ method, match }) => this.requiredRoutePermission(method, match),
    generateMetadata: (name, ctx) => this.generateMetadata(name, ctx),
    mergeMetadata: (parts) => this.mergeMetadata(parts),
    search: (query, ctx) => this.search(query, ctx),
    proxyIngest: (name, upstreamBase, ctx) => this.proxyIngest(name, upstreamBase, ctx),
    routes: [
      registryRoutes.get("/-/ping", "ping", () => Response.json({})),
      registryRoutes.get("/-/whoami", "whoami", ({ ctx }) =>
        Response.json({ username: this.whoamiUsername(ctx) }),
      ),
      registryRoutes.get("/-/v1/search", "search", ({ req, ctx }) => this.searchHandler(req, ctx)),
      registryRoutes.post("/-/npm/v1/security/advisories/bulk", "auditBulk", () =>
        Response.json({}),
      ),
      registryRoutes.post("/-/npm/v1/security/audits/quick", "auditQuick", () =>
        Response.json({ advisories: {}, vulnerabilities: {}, metadata: {} }),
      ),
      registryRoutes.get("/-/package/:pkg+/dist-tags", "distTagsList", ({ params, ctx }) =>
        this.distTagsList(params.pkg ?? "", ctx),
      ),
      registryRoutes.put("/-/package/:pkg+/dist-tags/:tag", "distTagSet", ({ params, req, ctx }) =>
        this.distTagSet(params.pkg ?? "", params.tag ?? "", req, ctx),
      ),
      registryRoutes.delete("/-/package/:pkg+/dist-tags/:tag", "distTagDelete", ({ params, ctx }) =>
        this.distTagDelete(params.pkg ?? "", params.tag ?? "", ctx),
      ),
      registryRoutes.get("/:pkg+/-/:filename", "tarball", ({ params, req, ctx }) =>
        this.tarball(params.pkg ?? "", params.filename ?? "", req, ctx),
      ),
      registryRoutes.put("/:pkg+", "publish", ({ params, req, ctx }) =>
        this.publish(params.pkg ?? "", req, ctx),
      ),
      registryRoutes.get("/:pkg+", "packument", ({ params, req, ctx }) =>
        this.packument(params.pkg ?? "", req, ctx),
      ),
    ],
  });
  private readonly delegate = delegateRegistryPlugin(this.plugin);

  routes = this.delegate.routes;

  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    return this.requiredRoutePermission(method, match);
  }

  private requiredRoutePermission(method: HttpMethod, match?: RouteMatch): Permission {
    const action =
      method === "GET" || method === "HEAD" || match?.entry.handlerId.startsWith("audit")
        ? "read"
        : "write";
    const pkg = match?.params.pkg;
    const filename = match?.params.filename;
    return {
      action,
      ...(pkg
        ? {
            resource: filename
              ? { type: "artifact" as const, packageName: pkg, artifactRef: filename }
              : { type: "package" as const, packageName: pkg },
          }
        : {}),
    };
  }

  handle = this.delegate.handle;

  private async findPackage(ctx: RegistryRequestContext, name: string) {
    return ctx.data.packages.findByName(name);
  }

  private async liveVersionsFor(
    ctx: RegistryRequestContext,
    pkg: RegistryPackageHandle,
    opts?: { orderByCreated?: "asc" | "desc" },
  ): Promise<RegistryPackageVersionRow[]> {
    return ctx.data.versions.listLive(pkg, opts);
  }

  private async distTags(
    ctx: RegistryRequestContext,
    pkg: RegistryPackageHandle,
  ): Promise<Record<string, string>> {
    return ctx.data.tags.listLive(pkg);
  }

  private whoamiUsername(ctx: RegistryRequestContext): string {
    const principal = ctx.principal;
    if (principal.kind === "user") return principal.username;
    if (principal.kind === "registryToken") return principal.subject;
    if (principal.kind === "token") {
      return principal.ownerUsername ?? principal.tokenName ?? `token:${principal.tokenId}`;
    }
    return "anonymous";
  }

  async generateMetadata(
    name: string,
    ctx: RegistryRequestContext,
  ): Promise<FormatMetadata | null> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return null;
    const versions = await this.liveVersionsFor(ctx, pkg);
    const tags = await this.distTags(ctx, pkg);
    return {
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(buildPackument(name, versions, tags)),
    };
  }

  async mergeMetadata(parts: FormatMetadata[]): Promise<FormatMetadata> {
    return mergePackuments(parts);
  }

  async search(query: SearchQuery, ctx: RegistryRequestContext): Promise<SearchResult> {
    const { packages: rows, total } = await ctx.data.packages.search({
      text: query.text,
      from: 0,
      size: query.limit ?? 20,
    });
    return {
      items: rows.map((row) => ({ name: row.name })),
      total,
    };
  }

  private async packument(
    name: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({ error: "Not found" }, { status: 404 });
    const versions = await this.liveVersionsFor(ctx, pkg);
    const tags = await this.distTags(ctx, pkg);
    const body = JSON.stringify(buildPackument(name, versions, tags));
    const etag = `"${sha1hexText(body)}"`;
    if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers: { etag } });
    return new Response(body, {
      headers: { "content-type": "application/json; charset=utf-8", etag },
    });
  }

  private async tarball(
    name: string,
    filename: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    name = parseNpmName(name);
    filename = parseRegistryInput(NpmTarballFilenameSchema, filename, {
      code: "NAME_INVALID",
      message: "invalid tarball filename",
    });
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({ error: "Not found" }, { status: 404 });
    const versions = await this.liveVersionsFor(ctx, pkg);
    let dist: NpmDist | undefined;
    let distVersion: string | null = null;
    for (const version of versions) {
      const metadata = parseNpmStoredVersionMetadata(version.metadata);
      if (metadata.dist?.filename === filename) {
        dist = metadata.dist;
        distVersion = version.version;
        break;
      }
    }
    if (!dist || !distVersion) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const etag = `"${dist.shasum}"`;
    return serveRegistryBlob(ctx, {
      digest: dist.blobDigest,
      kind: "npm_tarball",
      scope: `${name}@${distVersion}`,
      contentType: "application/octet-stream",
      extraHeaders: { etag },
      blocked: () => Response.json({ error: "artifact blocked by scan policy" }, { status: 403 }),
      notModified: () =>
        ifNoneMatch(req, etag) ? new Response(null, { status: 304, headers: { etag } }) : null,
    });
  }

  private async publish(
    name: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return handleNpmPublish(name, req, ctx);
  }

  private async versionRow(
    ctx: RegistryRequestContext,
    pkg: RegistryPackageHandle,
    version: string,
  ) {
    return ctx.data.versions.findLive(pkg, version);
  }

  private async distTagsList(name: string, ctx: RegistryRequestContext): Promise<Response> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({}, { status: 404 });
    return Response.json(await this.distTags(ctx, pkg));
  }

  private async distTagSet(
    name: string,
    tag: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({ error: "Not found" }, { status: 404 });
    tag = parseNpmDistTag(tag);
    const version = parseNpmDistTagRequestBody(await req.text());
    const row = await this.versionRow(ctx, pkg, version);
    if (!row) return Response.json({ error: "version not found" }, { status: 404 });
    await ctx.data.tags.set(pkg, tag, row);
    if (tag === "latest") {
      await ctx.data.tags.updateLatestVersion(pkg, version);
    }
    return Response.json({ ok: true });
  }

  private async distTagDelete(
    name: string,
    tag: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({ error: "Not found" }, { status: 404 });
    tag = parseNpmDistTag(tag);
    await ctx.data.tags.delete(pkg, tag);
    if (tag === "latest") {
      await ctx.data.tags.updateLatestVersion(pkg, null);
    }
    return Response.json({ ok: true });
  }

  /** Pull-through: mirror an upstream package (all versions) into this proxy repo. */
  async proxyIngest(
    pkgName: string,
    upstreamBase: string,
    ctx: RegistryRequestContext,
  ): Promise<boolean> {
    return handleNpmProxyIngest(pkgName, upstreamBase, ctx);
  }

  private async searchHandler(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const { text, from, size } = parseNpmSearchQuery(req.url);
    const { packages: rows, total } = await ctx.data.packages.search({ text, from, size });

    const objects: NpmSearchObject[] = [];
    for (const p of rows) {
      const versions = await this.liveVersionsFor(ctx, p, { orderByCreated: "desc" });
      if (versions.length === 0) continue;

      const tags = await this.distTags(ctx, p);
      const version = tags.latest ?? versions[0]!.version;
      const selected = versions.find((v) => v.version === version) ?? versions[0]!;
      objects.push(
        buildNpmSearchObject({
          packageName: p.name,
          selected,
          baseUrl: ctx.baseUrl,
          mountPath: ctx.repo.mountPath,
        }),
      );
    }

    return Response.json(buildNpmSearchResponse({ objects, total }));
  }
}

export const npmRegistryPlugin: RegistryPlugin = new NpmAdapter();
