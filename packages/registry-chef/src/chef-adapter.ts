import {
  basicAuthChallenge,
  delegateRegistryPlugin,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryMetadata,
  type RegistryPackageHandle,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import {
  buildChefCookbook,
  buildChefCookbookVersion,
  buildChefUniverseEntry,
  type ChefStoredVersion,
  type ChefUniverse,
  chefVersionFromSegment,
} from "./chef-metadata";
import { handleChefProxyIngest } from "./chef-proxy-lifecycle";
import { chefBlobScope, handleChefPublish } from "./chef-publish-lifecycle";
import { ChefCookbookNameSchema, ChefVersionSchema, parseChefVersionMeta } from "./chef-validation";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const TARBALL_MEDIA_TYPE = "application/gzip";

function parseCookbookName(name: string): string {
  return parseRegistryInput(ChefCookbookNameSchema, name, {
    code: "NAME_INVALID",
    message: "invalid Chef cookbook name",
  });
}

function parseCookbookVersion(version: string): string {
  return parseRegistryInput(ChefVersionSchema, version, {
    code: "MANIFEST_INVALID",
    message: "invalid Chef cookbook version",
  });
}

/**
 * Chef Supermarket. Serves the `/universe` dependency document, the v1 cookbook
 * API (cookbook listing + per-version detail + tarball download), and accepts
 * `POST /api/v1/cookbooks` publishes (multipart `tarball` + `cookbook` JSON).
 * Proxyable (mirrors supermarket.chef.io) and virtualizable.
 */
export class ChefAdapter implements RegistryPlugin {
  readonly id = "chef" as const;
  readonly capabilities = registryCapabilities("proxyable", "virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Chef Supermarket",
      mountSegment: "chef",
      errorResponseKind: "singleError",
      compressibleHandlers: ["universe", "cookbook", "cookbookVersion"],
      scan: {
        defaultOsvEcosystem: undefined,
        dependencyGraph: ({ metadata }) => ({
          deps: chefDependencyGraph(metadata),
          osvEcosystem: undefined,
          purlType: "chef",
        }),
        referencedDigests: (metadata) =>
          typeof metadata.tarballDigest === "string" ? [metadata.tarballDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .generateMetadata((name, ctx) => this.buildCookbookMetadata(name, ctx))
    .mergeMetadata((parts) => this.mergeCookbookMetadata(parts))
    .proxyIngest((name, upstreamBase, ctx) => this.ingestProxy(name, upstreamBase, ctx))
    .routes((route) => [
      // `/universe` is a literal segment declared before the `:name` catch-alls.
      route.get("/universe", "universe", ({ req, ctx }) => this.universe(req, ctx)),
      route.post("/api/v1/cookbooks", "publish", ({ req, ctx }) => this.publish(req, ctx)),
      route.get(
        "/api/v1/cookbooks/:name/versions/:version/download",
        "download",
        ({ params, req, ctx }) => this.download(params.name, params.version, req, ctx),
      ),
      route.get(
        "/api/v1/cookbooks/:name/versions/:version",
        "cookbookVersion",
        ({ params, req, ctx }) => this.cookbookVersion(params.name, params.version, req, ctx),
      ),
      route.get(
        "/api/v1/cookbooks/:name",
        "cookbook",
        ({ params, req, ctx }) => this.cookbook(params.name, req, ctx),
        { proxyRefreshTrigger: true, metadataMergeable: true, packageParam: "name" },
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
  get generateMetadata() {
    return this.plugin.generateMetadata;
  }
  get mergeMetadata() {
    return this.plugin.mergeMetadata;
  }
  get proxyIngest() {
    return this.plugin.proxyIngest;
  }

  routes = this.delegate.routes;

  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    const permission = readWritePermission(method);
    const nameRaw = match?.params.name;
    const name = nameRaw && ChefCookbookNameSchema.safeParse(nameRaw).success ? nameRaw : null;
    const versionRaw = match?.params.version;
    if (name && versionRaw && match?.entry.handlerId === "download") {
      const version = ChefVersionSchema.safeParse(chefVersionFromSegment(versionRaw)).success
        ? chefVersionFromSegment(versionRaw)
        : versionRaw;
      return {
        ...permission,
        resource: {
          type: "artifact",
          packageName: name,
          artifactRef: chefBlobScope(name, version),
        },
      };
    }
    if (name) {
      return { ...permission, resource: { type: "package", packageName: name } };
    }
    return permission;
  }

  handle = this.delegate.handle;

  /** All live versions of a cookbook, paired with their parsed metadata. */
  private async storedVersions(
    pkg: RegistryPackageHandle,
    ctx: RegistryRequestContext,
  ): Promise<ChefStoredVersion[]> {
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "desc" });
    return rows.flatMap((row) => {
      const metadata = parseChefVersionMeta(row.metadata);
      if (!metadata) return [];
      return [{ version: row.version, metadata, sizeBytes: row.sizeBytes }];
    });
  }

  /** `GET /universe` — the dependency-resolution document over all live cookbooks. */
  private async universe(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const names = await ctx.data.packages.listNames();
    const universe: ChefUniverse = {};
    // Deterministic ordering so the ETag is stable across requests.
    for (const { name } of [...names].sort((a, b) => a.name.localeCompare(b.name))) {
      const pkg = await ctx.data.packages.findByName(name);
      if (!pkg) continue;
      const versions = await this.storedVersions(pkg, ctx);
      if (versions.length === 0) continue;
      const entries: Record<string, ReturnType<typeof buildChefUniverseEntry>> = {};
      for (const { version, metadata } of versions) {
        entries[version] = buildChefUniverseEntry({
          baseUrl: ctx.baseUrl,
          mountPath: ctx.repo.mountPath,
          name,
          version,
          metadata,
        });
      }
      universe[name] = entries;
    }
    return textResponseWithEtag(req, JSON.stringify(universe), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  /** `GET /api/v1/cookbooks/:name` — the cookbook JSON (versions as URLs). */
  private async cookbook(
    nameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const name = parseCookbookName(nameRaw);
    const body = await this.cookbookBody(name, ctx);
    if (!body) return new Response("Not Found", { status: 404 });
    return textResponseWithEtag(req, body, { "content-type": JSON_CONTENT_TYPE });
  }

  /** Serialized cookbook JSON, or null when the cookbook has no live versions. */
  private async cookbookBody(name: string, ctx: RegistryRequestContext): Promise<string | null> {
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return null;
    const versions = await this.storedVersions(pkg, ctx);
    const cookbook = buildChefCookbook({
      baseUrl: ctx.baseUrl,
      mountPath: ctx.repo.mountPath,
      name,
      versions,
    });
    return cookbook ? JSON.stringify(cookbook) : null;
  }

  /** `GET /api/v1/cookbooks/:name/versions/:version` — single-version detail. */
  private async cookbookVersion(
    nameRaw: string,
    versionRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const name = parseCookbookName(nameRaw);
    const version = parseCookbookVersion(chefVersionFromSegment(versionRaw));
    const stored = await this.findVersion(name, version, ctx);
    if (!stored) return new Response("Not Found", { status: 404 });
    return textResponseWithEtag(
      req,
      JSON.stringify(
        buildChefCookbookVersion({
          baseUrl: ctx.baseUrl,
          mountPath: ctx.repo.mountPath,
          name,
          version: stored,
        }),
      ),
      { "content-type": JSON_CONTENT_TYPE },
    );
  }

  /** `GET /api/v1/cookbooks/:name/versions/:version/download` — the tarball blob. */
  private async download(
    nameRaw: string,
    versionRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const name = parseCookbookName(nameRaw);
    const version = parseCookbookVersion(chefVersionFromSegment(versionRaw));
    const stored = await this.findVersion(name, version, ctx);
    if (!stored) return new Response("Not Found", { status: 404 });
    return serveRegistryBlob(ctx, {
      digest: stored.metadata.tarballDigest,
      kind: "chef_cookbook",
      scope: chefBlobScope(name, version),
      contentType: TARBALL_MEDIA_TYPE,
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  /** A live cookbook version paired with its metadata, or null when not found. */
  private async findVersion(
    name: string,
    version: string,
    ctx: RegistryRequestContext,
  ): Promise<ChefStoredVersion | null> {
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return null;
    const row = await ctx.data.versions.findLive(pkg, version);
    const metadata = parseChefVersionMeta(row?.metadata);
    if (!row || !metadata) return null;
    return { version, metadata, sizeBytes: row.sizeBytes };
  }

  private publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleChefPublish(req, ctx);
  }

  /** Virtual-merge source: the per-cookbook listing for `name`, or null if absent. */
  private async buildCookbookMetadata(
    name: string,
    ctx: RegistryRequestContext,
  ): Promise<RegistryMetadata | null> {
    name = parseCookbookName(name);
    const body = await this.cookbookBody(name, ctx);
    if (!body) return null;
    return { contentType: JSON_CONTENT_TYPE, body };
  }

  /** Merge per-member cookbook listings: union their version URL lists, first wins. */
  private async mergeCookbookMetadata(parts: RegistryMetadata[]): Promise<RegistryMetadata> {
    return mergeChefCookbooks(parts);
  }

  /** Pull-through: mirror an upstream Supermarket cookbook into this proxy repo. */
  private ingestProxy(
    name: string,
    upstreamBase: string,
    ctx: RegistryRequestContext,
  ): Promise<boolean> {
    if (!ChefCookbookNameSchema.safeParse(name).success) return Promise.resolve(false);
    return handleChefProxyIngest(name, upstreamBase, ctx);
  }
}

/** Merge cookbook listings across virtual members, preferring the first member. */
export function mergeChefCookbooks(parts: RegistryMetadata[]): RegistryMetadata {
  let base: Record<string, unknown> | null = null;
  const versionUrls: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const body = typeof part.body === "string" ? part.body : new TextDecoder().decode(part.body);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    base ??= record;
    const urls = Array.isArray(record.versions) ? record.versions : [];
    for (const url of urls) {
      if (typeof url === "string" && !seen.has(url)) {
        seen.add(url);
        versionUrls.push(url);
      }
    }
  }
  const merged = { ...(base ?? {}), versions: versionUrls };
  return { contentType: JSON_CONTENT_TYPE, body: JSON.stringify(merged) };
}

function chefDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const parsed = parseChefVersionMeta(metadata);
  const deps = parsed?.dependencies;
  if (!deps) return {};
  return Object.fromEntries(Object.entries(deps).map(([name, range]) => [name, String(range)]));
}

export const chefRegistryPlugin: RegistryPlugin = new ChefAdapter();
