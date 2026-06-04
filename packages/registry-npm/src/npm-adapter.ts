import {
  basicAuthChallenge,
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
  registryCapabilities,
  registryPlugin,
  type SearchQuery,
  type SearchResult,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { parseNpmDistTag, parseNpmDistTagRequestBody } from "./npm-dist-tags";
import { ifNoneMatch } from "./npm-http";
import type { NpmDist } from "./npm-integrity";
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
  versionFromTarballFilename,
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
  readonly capabilities = registryCapabilities("proxyable", "virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.format)
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .defaultPermission(({ method, match }) => this.requiredRoutePermission(method, match))
    .generateMetadata((name, ctx) => this.generateMetadata(name, ctx))
    .mergeMetadata((parts) => this.mergeMetadata(parts))
    .search((query, ctx) => this.search(query, ctx))
    .proxyIngest((name, upstreamBase, ctx) => this.proxyIngest(name, upstreamBase, ctx))
    .routes((route) => [
      route.get("/-/ping", "ping", () => Response.json({})),
      route.get("/-/whoami", "whoami", ({ ctx }) =>
        Response.json({ username: this.whoamiUsername(ctx) }),
      ),
      route.get("/-/v1/search", "search", ({ req, ctx }) => this.searchHandler(req, ctx)),
      route.post("/-/npm/v1/security/advisories/bulk", "auditBulk", () => Response.json({})),
      route.post("/-/npm/v1/security/audits/quick", "auditQuick", () =>
        Response.json({ advisories: {}, vulnerabilities: {}, metadata: {} }),
      ),
      route.get("/-/package/:pkg+/dist-tags", "distTagsList", ({ params, ctx }) =>
        this.distTagsList(params.pkg, ctx),
      ),
      route.put("/-/package/:pkg+/dist-tags/:tag", "distTagSet", ({ params, req, ctx }) =>
        this.distTagSet(params.pkg, params.tag, req, ctx),
      ),
      route.delete("/-/package/:pkg+/dist-tags/:tag", "distTagDelete", ({ params, ctx }) =>
        this.distTagDelete(params.pkg, params.tag, ctx),
      ),
      route.get("/:pkg+/-/:filename", "tarball", ({ params, req, ctx }) =>
        this.tarball(params.pkg, params.filename, req, ctx),
      ),
      route.put("/:pkg+", "publish", ({ params, req, ctx }) => this.publish(params.pkg, req, ctx)),
      route.get("/:pkg+", "packument", ({ params, req, ctx }) =>
        this.packument(params.pkg, req, ctx),
      ),
    ])
    .build();
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
    return textResponseWithEtag(req, body, { "content-type": "application/json; charset=utf-8" });
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
    const distVersion = versionFromTarballFilename(name, filename);
    const version = distVersion ? await this.versionRow(ctx, pkg, distVersion) : null;
    const metadata = version ? parseNpmStoredVersionMetadata(version.metadata) : null;
    const dist: NpmDist | undefined =
      metadata?.dist?.filename === filename ? metadata.dist : undefined;
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
    const tagsByPackageId = await ctx.data.tags.listLiveForPackages(rows);
    const preferredVersionsByPackageId = new Map(
      rows.flatMap((row) => {
        const latest = tagsByPackageId.get(row.id)?.latest;
        return latest ? [[row.id, latest] as const] : [];
      }),
    );
    const versionsByPackageId = await ctx.data.versions.listSearchVersionsForPackages(
      rows,
      preferredVersionsByPackageId,
    );

    const objects: NpmSearchObject[] = [];
    for (const p of rows) {
      const selected = versionsByPackageId.get(p.id);
      if (!selected) continue;
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
