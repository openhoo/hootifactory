import {
  type RegistryMetadata,
  type RegistryPlugin,
  type RegistryRequestContext,
  registryAdapter,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { puppetBadRequest, puppetNotFound } from "./puppet-errors";
import {
  buildPuppetModuleObject,
  buildPuppetReleaseListResponse,
  buildPuppetReleaseObject,
  comparePuppetVersions,
  isPrereleasePuppetVersion,
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
class PuppetAdapterState {
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
  async module(slugRaw: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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
  async release(releaseRaw: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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
  async releaseList(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const url = new URL(req.url);
    const moduleParam = url.searchParams.get("module");
    if (!moduleParam) return puppetBadRequest("the 'module' query parameter is required");
    const slug = parsePuppetSlug(moduleParam);
    if (!slug) return puppetBadRequest("invalid module slug");

    const limit = clampLimit(url.searchParams.get("limit"));
    const offset = clampOffset(url.searchParams.get("offset"));
    const releases = await this.storedReleases(slug.slug, ctx);
    // Forge orders the release list newest-version-first. storedReleases is in DB
    // creation order, which diverges from version order for out-of-order publishes
    // and unordered proxy mirroring, so sort by version-desc before paginating to
    // stay deterministic and consistent with the module endpoint's `releases`.
    releases.sort((a, b) => comparePuppetVersionsDesc(a.version, b.version));
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
  async file(filenameRaw: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

  publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
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
    // Each member advertises a full `current_release` object; collect them keyed by
    // version so we can re-select the merged current with the SAME stable-preference
    // rule buildPuppetModuleObject uses, rather than blindly taking the highest
    // version overall (which could surface a prerelease a single repo never would).
    const currentCandidates = new Map<string, unknown>();
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
      if (currentRelease?.version && !currentCandidates.has(currentRelease.version)) {
        currentCandidates.set(currentRelease.version, currentRelease);
      }
    }

    // Prefer the highest non-prerelease current_release across members, falling back
    // to the highest overall only when no member's current is a stable release.
    const candidateVersions = [...currentCandidates.keys()].sort(comparePuppetVersionsDesc);
    const stableCurrent = candidateVersions.find((v) => !isPrereleasePuppetVersion(v));
    const currentVersion = stableCurrent ?? candidateVersions[0];

    const merged = {
      ...primary,
      releases: [...releaseByVersion.values()].sort((a, b) =>
        comparePuppetVersionsDesc(
          (a as { version: string }).version,
          (b as { version: string }).version,
        ),
      ),
      current_release:
        (currentVersion !== undefined ? currentCandidates.get(currentVersion) : undefined) ??
        primary.current_release,
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

const puppetDefinition = registryAdapter("puppet")
  .stateClass(PuppetAdapterState)
  .module((module) =>
    module
      .displayName("Puppet Forge")
      .mount("puppet")
      .capabilities("proxyable", "virtualizable")
      .errorResponseKind("singleError")
      .compressible({
        handlers: ["module", "releaseList", "release"],
        contentTypes: [PUPPET_JSON_CONTENT_TYPE],
      }),
  )
  .scan({
    defaultOsvEcosystem: "Puppet",
    dependencyGraph: ({ metadata }) => ({
      deps: puppetDependencyGraph(metadata),
      osvEcosystem: "Puppet",
      purlType: "puppet",
    }),
    referencedDigests: (metadata) =>
      typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
  })
  .bearerAuth()
  .fromState((state) =>
    state
      .metadata({ generate: "generateMetadata", merge: "mergeMetadata" })
      .proxyIngest("proxyIngest"),
  )
  .permissions((p) =>
    p.byParams([
      p.packageRule({ param: "slug", normalize: (slug) => parsePuppetSlug(slug)?.slug ?? null }),
      p.artifactRule({
        param: "release",
        normalize: (release) => {
          const parsed = parsePuppetReleaseSlug(release);
          return parsed ? puppetBlobScope(parsed.slug, parsed.version) : null;
        },
        packageName: ({ params }) =>
          params.release ? parsePuppetReleaseSlug(params.release)?.slug : undefined,
      }),
      p.artifactRule({
        param: "filename",
        normalize: (filename) => {
          const ref = fileToRelease(filename);
          return ref ? puppetBlobScope(ref.slug, ref.version) : null;
        },
        packageName: ({ params }) =>
          params.filename ? fileToRelease(params.filename)?.slug : undefined,
      }),
    ]),
  )
  .routes((route) => [
    // Literal `/v3/releases` (list + publish) is declared before the
    // `/v3/releases/:release` catch-all so it cannot be shadowed.
    route
      .get("/v3/releases", "releaseList")
      .calls((state, { req, ctx }) => state.releaseList(req, ctx)),
    route.post("/v3/releases", "publish").calls((state, { req, ctx }) => state.publish(req, ctx)),
    route
      .get("/v3/releases/:release", "release")
      .calls((state, { params, req, ctx }) => state.release(params.release, req, ctx)),
    route
      .get("/v3/files/:filename", "file")
      .calls((state, { params, req, ctx }) => state.file(params.filename, req, ctx)),
    route
      .get("/v3/modules/:slug", "module")
      .metadata("slug", { proxyRefresh: true })
      .calls((state, { params, req, ctx }) => state.module(params.slug, req, ctx)),
  ]);

export class PuppetAdapter extends puppetDefinition.adapterClass() {}
export const puppetRegistryPlugin: RegistryPlugin = new PuppetAdapter();
