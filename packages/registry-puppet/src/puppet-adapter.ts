import {
  bearerAuthChallenge,
  delegateRegistryPlugin,
  type HttpMethod,
  type Permission,
  type RegistryMetadata,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { puppetBadRequest, puppetNotFound } from "./puppet-errors";
import {
  buildPuppetModuleObject,
  buildPuppetReleaseListResponse,
  buildPuppetReleaseObject,
  comparePuppetVersions,
  type PuppetReleaseInput,
  type PuppetReleaseListEntry,
  type PuppetUrlContext,
} from "./puppet-metadata";
import { handlePuppetProxyIngest } from "./puppet-proxy-lifecycle";
import { puppetBlobScope } from "./puppet-publish";
import { handlePuppetPublish } from "./puppet-publish-lifecycle";
import {
  PuppetFileNameSchema,
  parsePuppetReleaseMeta,
  parsePuppetReleaseSlug,
  parsePuppetSlug,
  puppetReleaseFileName,
} from "./puppet-validation";

const PUPPET_JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const DEFAULT_RELEASE_LIMIT = 20;
const MAX_RELEASE_LIMIT = 100;

/**
 * Puppet Forge v3 API. Serves the module JSON (`current_release` + `releases`),
 * the paginated release listing (`GET /v3/releases?module=<slug>`), single-release
 * detail (incl. `file_uri`/`file_md5`/`file_sha256`), the tarball blob, and the
 * `POST /v3/releases` multipart publish. Module/release JSON is regenerated from
 * the live stored versions on every read.
 */
export class PuppetAdapter implements RegistryPlugin {
  readonly id = "puppet" as const;
  readonly capabilities = registryCapabilities("proxyable", "virtualizable");
  authChallenge = () => bearerAuthChallenge();

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Puppet Forge",
      mountSegment: "puppet",
      errorResponseKind: "singleError",
      compressibleHandlers: ["module", "releaseList", "release"],
      compressibleContentTypes: [PUPPET_JSON_CONTENT_TYPE],
      scan: {
        defaultOsvEcosystem: "Puppet",
        dependencyGraph: ({ metadata }) => ({
          deps: puppetDependencyGraph(metadata),
          osvEcosystem: "Puppet",
          purlType: "puppet",
        }),
        referencedDigests: (metadata) =>
          typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .generateMetadata((slug, ctx) => this.generateMetadata(slug, ctx))
    .mergeMetadata((parts) => this.mergeMetadata(parts))
    .proxyIngest((slug, upstreamBase, ctx) => this.proxyIngest(slug, upstreamBase, ctx))
    .routes((route) => [
      // Literal `/v3/releases` (list + publish) is declared before the
      // `/v3/releases/:release` catch-all so it cannot be shadowed.
      route.get("/v3/releases", "releaseList", ({ req, ctx }) => this.releaseList(req, ctx)),
      route.post("/v3/releases", "publish", ({ req, ctx }) => this.publish(req, ctx)),
      route.get("/v3/releases/:release", "release", ({ params, req, ctx }) =>
        this.release(params.release, req, ctx),
      ),
      route.get("/v3/files/:filename", "file", ({ params, req, ctx }) =>
        this.file(params.filename, req, ctx),
      ),
      route.get(
        "/v3/modules/:slug",
        "module",
        ({ params, req, ctx }) => this.module(params.slug, req, ctx),
        { proxyRefreshTrigger: true, metadataMergeable: true, packageParam: "slug" },
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
    const handlerId = match?.entry?.handlerId;

    if (handlerId === "module") {
      const slug = parsePuppetSlug(match?.params.slug ?? "");
      if (slug) {
        return { ...permission, resource: { type: "package", packageName: slug.slug } };
      }
    }

    if (handlerId === "release") {
      const release = parsePuppetReleaseSlug(match?.params.release ?? "");
      if (release) {
        return {
          ...permission,
          resource: {
            type: "artifact",
            packageName: release.slug,
            artifactRef: puppetBlobScope(release.slug, release.version),
          },
        };
      }
    }

    if (handlerId === "file") {
      const ref = fileToRelease(match?.params.filename ?? "");
      if (ref) {
        return {
          ...permission,
          resource: {
            type: "artifact",
            packageName: ref.slug,
            artifactRef: puppetBlobScope(ref.slug, ref.version),
          },
        };
      }
    }

    return permission;
  }

  handle = this.delegate.handle;

  private urlContext(ctx: RegistryRequestContext): PuppetUrlContext {
    return { baseUrl: ctx.baseUrl, mountPath: ctx.repo.mountPath };
  }

  /** Live releases for a module slug, parsed from stored metadata (newest first). */
  private async storedReleases(
    slug: string,
    ctx: RegistryRequestContext,
  ): Promise<PuppetReleaseInput[]> {
    const pkg = await ctx.data.packages.findByName(slug);
    if (!pkg) return [];
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "desc" });
    return rows.flatMap((row) => {
      const meta = parsePuppetReleaseMeta(row.metadata);
      return meta ? [{ version: row.version, meta }] : [];
    });
  }

  /** `GET /v3/modules/:slug` — the module JSON regenerated from live releases. */
  private async module(
    slugRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const slug = parsePuppetSlug(slugRaw);
    if (!slug) return puppetBadRequest("invalid module slug");
    const releases = await this.storedReleases(slug.slug, ctx);
    const object = buildPuppetModuleObject({
      owner: slug.owner,
      name: slug.name,
      releases,
      url: this.urlContext(ctx),
    });
    if (!object) return puppetNotFound(`module ${slug.slug} not found`);
    return textResponseWithEtag(req, JSON.stringify(object), {
      "content-type": PUPPET_JSON_CONTENT_TYPE,
    });
  }

  /** `GET /v3/releases/:release` — the single-release detail object. */
  private async release(
    releaseRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const release = parsePuppetReleaseSlug(releaseRaw);
    if (!release) return puppetBadRequest("invalid release slug");
    const pkg = await ctx.data.packages.findByName(release.slug);
    if (!pkg) return puppetNotFound(`release ${releaseRaw} not found`);
    const row = await ctx.data.versions.findLive(pkg, release.version);
    const meta = parsePuppetReleaseMeta(row?.metadata);
    if (!meta) return puppetNotFound(`release ${releaseRaw} not found`);
    const object = buildPuppetReleaseObject({
      owner: release.owner,
      name: release.name,
      version: release.version,
      meta,
      url: this.urlContext(ctx),
    });
    return textResponseWithEtag(req, JSON.stringify(object), {
      "content-type": PUPPET_JSON_CONTENT_TYPE,
    });
  }

  /** `GET /v3/releases?module=<slug>[&limit&offset]` — the paginated release list. */
  private async releaseList(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const url = new URL(req.url);
    const moduleParam = url.searchParams.get("module");
    if (!moduleParam) return puppetBadRequest("the 'module' query parameter is required");
    const slug = parsePuppetSlug(moduleParam);
    if (!slug) return puppetBadRequest("invalid module slug");

    const limit = clampLimit(url.searchParams.get("limit"));
    const offset = clampOffset(url.searchParams.get("offset"));
    const releases = await this.storedReleases(slug.slug, ctx);
    const total = releases.length;
    const page = releases.slice(offset, offset + limit);
    const entries: PuppetReleaseListEntry[] = page.map((release) => ({
      owner: slug.owner,
      name: slug.name,
      version: release.version,
      meta: release.meta,
    }));

    const body = buildPuppetReleaseListResponse({
      entries,
      limit,
      offset,
      total,
      basePath: `/${ctx.repo.mountPath}/v3/releases?module=${slug.slug}`,
      url: this.urlContext(ctx),
    });
    return textResponseWithEtag(req, JSON.stringify(body), {
      "content-type": PUPPET_JSON_CONTENT_TYPE,
    });
  }

  /** `GET /v3/files/:filename` — serve the hosted release tarball blob. */
  private async file(
    filenameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const filename = PuppetFileNameSchema.safeParse(filenameRaw);
    if (!filename.success) return puppetBadRequest("invalid release filename");
    const ref = fileToRelease(filename.data);
    if (!ref) return puppetNotFound(`file ${filenameRaw} not found`);
    const pkg = await ctx.data.packages.findByName(ref.slug);
    if (!pkg) return puppetNotFound(`file ${filenameRaw} not found`);
    const row = await ctx.data.versions.findLive(pkg, ref.version);
    const meta = parsePuppetReleaseMeta(row?.metadata);
    // The requested filename must match the canonical name for this release.
    if (!meta || puppetReleaseFileName(ref.owner, ref.name, ref.version) !== filename.data) {
      return puppetNotFound(`file ${filenameRaw} not found`);
    }
    return serveRegistryBlob(ctx, {
      digest: meta.blobDigest,
      kind: "puppet_release",
      scope: puppetBlobScope(ref.slug, ref.version),
      contentType: ARCHIVE_CONTENT_TYPE,
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
      missing: () => puppetNotFound(`file ${filenameRaw} not found`),
    });
  }

  private publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handlePuppetPublish(req, ctx);
  }

  async proxyIngest(
    slug: string,
    upstreamBase: string,
    ctx: RegistryRequestContext,
  ): Promise<boolean> {
    const parsed = parsePuppetSlug(slug);
    if (!parsed) return false;
    return handlePuppetProxyIngest(parsed.slug, upstreamBase, ctx);
  }

  /** Virtual-repo module metadata: the module JSON body for a slug, or null. */
  async generateMetadata(
    slugRaw: string,
    ctx: RegistryRequestContext,
  ): Promise<RegistryMetadata | null> {
    const slug = parsePuppetSlug(slugRaw);
    if (!slug) return null;
    const releases = await this.storedReleases(slug.slug, ctx);
    const object = buildPuppetModuleObject({
      owner: slug.owner,
      name: slug.name,
      releases,
      url: this.urlContext(ctx),
    });
    if (!object) return null;
    return { contentType: PUPPET_JSON_CONTENT_TYPE, body: JSON.stringify(object) };
  }

  /**
   * Merge module JSON across virtual members: union the `releases` by version and
   * recompute `current_release` so a module split across member repos presents as
   * a single module document.
   */
  async mergeMetadata(parts: RegistryMetadata[]): Promise<RegistryMetadata> {
    const objects = parts.flatMap((part) => {
      try {
        return [JSON.parse(typeof part.body === "string" ? part.body : "")];
      } catch {
        return [];
      }
    });
    const primary = objects.find((object) => object?.owner?.username && object?.name);
    if (!primary) {
      return { contentType: PUPPET_JSON_CONTENT_TYPE, body: parts[0]?.body ?? "{}" };
    }

    const releaseByVersion = new Map<string, unknown>();
    let current: { version: string; release: unknown } | null = null;
    for (const object of objects) {
      const owner = object?.owner?.username;
      const name = object?.name;
      if (owner !== primary.owner.username || name !== primary.name) continue;
      for (const release of (object.releases as { version?: string }[] | undefined) ?? []) {
        if (typeof release.version === "string" && !releaseByVersion.has(release.version)) {
          releaseByVersion.set(release.version, release);
        }
      }
      const currentRelease = object.current_release as { version?: string } | undefined;
      if (
        currentRelease?.version &&
        (!current || comparePuppetVersionsDesc(currentRelease.version, current.version) < 0)
      ) {
        current = { version: currentRelease.version, release: currentRelease };
      }
    }

    const merged = {
      ...primary,
      releases: [...releaseByVersion.values()].sort((a, b) =>
        comparePuppetVersionsDesc(
          (a as { version: string }).version,
          (b as { version: string }).version,
        ),
      ),
      current_release: current?.release ?? primary.current_release,
    };
    return { contentType: PUPPET_JSON_CONTENT_TYPE, body: JSON.stringify(merged) };
  }
}

const ARCHIVE_CONTENT_TYPE = "application/gzip";

interface FileReleaseRef {
  owner: string;
  name: string;
  version: string;
  slug: string;
}

/** Resolve a `<owner>-<name>-<version>.tar.gz` filename to its release coordinates. */
function fileToRelease(filename: string): FileReleaseRef | null {
  if (!filename.endsWith(".tar.gz")) return null;
  const release = parsePuppetReleaseSlug(filename.slice(0, -".tar.gz".length));
  if (!release) return null;
  return { owner: release.owner, name: release.name, version: release.version, slug: release.slug };
}

function clampLimit(raw: string | null): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_RELEASE_LIMIT;
  return Math.min(Math.floor(value), MAX_RELEASE_LIMIT);
}

function clampOffset(raw: string | null): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** Descending SemVer comparison: newest version first. */
function comparePuppetVersionsDesc(a: string, b: string): number {
  return comparePuppetVersions(b, a);
}

function puppetDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const meta = parsePuppetReleaseMeta(metadata);
  const deps = meta?.metadata.dependencies;
  if (!deps) return {};
  return Object.fromEntries(deps.map((dep) => [dep.name, dep.version_requirement ?? "*"] as const));
}

export const puppetRegistryPlugin: RegistryPlugin = new PuppetAdapter();
