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
import {
  buildWingetPackageManifest,
  buildWingetPackageManifestResponse,
  buildWingetSearchResponse,
  buildWingetSearchResult,
  type WingetSearchResult,
  wingetData,
  wingetErrorResponse,
  wingetMatches,
} from "./winget-documents";
import { wingetInstallerScope } from "./winget-publish";
import { handleWingetPublish } from "./winget-upload-lifecycle";
import {
  parseWingetVersionMeta,
  WingetFilenameSchema,
  WingetPackageIdentifierSchema,
  WingetSearchRequestSchema,
  type WingetVersionMeta,
  WingetVersionSchema,
  wingetSearchCriteria,
} from "./winget-validation";

const WINGET_SOURCE_SUPPORTED_VERSIONS = ["1.0.0", "1.1.0"] as const;
const WINGET_SEARCH_PACKAGE_BATCH_SIZE = 250;
const WINGET_SEARCH_DEFAULT_LIMIT = 250;

function parsePackageIdentifier(identifier: string): string {
  return parseRegistryInput(WingetPackageIdentifierSchema, identifier, {
    code: "NAME_INVALID",
    message: "invalid PackageIdentifier",
  });
}

function parseVersion(version: string): string {
  return parseRegistryInput(WingetVersionSchema, version, {
    code: "MANIFEST_UNKNOWN",
    message: "invalid PackageVersion",
    status: 404,
  });
}

interface WingetStoredVersion {
  version: string;
  metadata: WingetVersionMeta;
}

/**
 * Windows Package Manager (winget) REST source, v1.x. The consumption surface
 * (information, manifestSearch, packageManifests, installer download) speaks
 * the read-only winget REST protocol. Publishing via
 * `PUT /api/packageManifests/:id` is a HOOTIFACTORY EXTENSION — the public
 * winget REST source API has no write path.
 */
export class WingetAdapter implements RegistryPlugin {
  readonly id = "winget" as const;
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "winget",
      mountSegment: "winget",
      errorResponseKind: "singleError",
      compressibleHandlers: ["information", "search", "packageManifests"],
      scan: {
        defaultOsvEcosystem: "winget",
        referencedDigests: (metadata) =>
          typeof metadata.installerDigest === "string" ? [metadata.installerDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      route.get("/api/information", "information", ({ ctx }) => this.information(ctx)),
      route.post("/api/manifestSearch", "search", ({ req, ctx }) => this.manifestSearch(req, ctx), {
        searchable: true,
      }),
      route.get(
        "/api/packageManifests/:packageIdentifier",
        "packageManifests",
        ({ params, req, ctx }) => this.packageManifests(params.packageIdentifier, req, ctx),
      ),
      route.put("/api/packageManifests/:packageIdentifier", "publish", ({ params, req, ctx }) =>
        this.publish(params.packageIdentifier, req, ctx),
      ),
      route.get(
        "/api/installers/:packageIdentifier/:version/:filename",
        "download",
        ({ params, req, ctx }) =>
          this.download(params.packageIdentifier, params.version, params.filename, req, ctx),
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
    const packageIdentifier = match?.params.packageIdentifier;
    const version = match?.params.version;
    const filename = match?.params.filename;
    if (packageIdentifier && version && filename) {
      return {
        ...permission,
        resource: {
          type: "artifact",
          packageName: packageIdentifier.toLowerCase(),
          artifactRef: wingetInstallerScope(packageIdentifier, version, filename),
        },
      };
    }
    if (packageIdentifier) {
      return {
        ...permission,
        resource: { type: "package", packageName: packageIdentifier.toLowerCase() },
      };
    }
    return permission;
  }

  handle = this.delegate.handle;

  private base(ctx: RegistryRequestContext): { baseUrl: string; mountPath: string } {
    return { baseUrl: ctx.baseUrl, mountPath: ctx.repo.mountPath };
  }

  private information(ctx: RegistryRequestContext): Response {
    return Response.json(
      wingetData({
        SourceIdentifier: ctx.repo.name,
        ServerSupportedVersions: [...WINGET_SOURCE_SUPPORTED_VERSIONS],
      }),
    );
  }

  private async storedVersions(
    ctx: RegistryRequestContext,
    pkg: { id: string; orgId: string; repositoryId: string; name: string },
  ): Promise<WingetStoredVersion[]> {
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" });
    return rows.flatMap((row) => {
      const metadata = parseWingetVersionMeta(row.metadata);
      return metadata ? [{ version: row.version, metadata }] : [];
    });
  }

  private async packageManifests(
    packageIdentifierRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const packageIdentifier = parsePackageIdentifier(packageIdentifierRaw);
    const requestedVersion = this.requestedVersion(req);
    const pkg = await ctx.data.packages.findByName(packageIdentifier.toLowerCase());
    if (!pkg) return this.notFoundEnvelope();
    let versions = await this.storedVersions(ctx, pkg);
    if (requestedVersion) {
      versions = versions.filter((entry) => entry.version === requestedVersion);
    }
    if (versions.length === 0) return this.notFoundEnvelope();
    const { baseUrl, mountPath } = this.base(ctx);
    // Reconstruct the published identifier casing from version metadata so reads
    // echo `Publisher.Package` as published rather than the URL-segment casing.
    const newest = versions[versions.length - 1];
    const canonicalIdentifier = newest
      ? this.identifierFor(pkg.name, newest.metadata)
      : packageIdentifier;
    const document = buildWingetPackageManifest({
      baseUrl,
      mountPath,
      packageIdentifier: canonicalIdentifier,
      versions,
    });
    return textResponseWithEtag(req, JSON.stringify(buildWingetPackageManifestResponse(document)), {
      "content-type": "application/json; charset=utf-8",
    });
  }

  private requestedVersion(req: Request): string | null {
    const raw = new URL(req.url).searchParams.get("Version");
    if (raw === null || raw === "") return null;
    return parseVersion(raw);
  }

  /**
   * winget renders error bodies as a top-level array of `{ ErrorCode,
   * ErrorMessage }` (WinGet-1.1.0.yaml). A missing package/version is a 404 with
   * that shape — the same shape every other error path in this source emits.
   */
  private notFoundEnvelope(): Response {
    return wingetErrorResponse(404, "package not found");
  }

  private async manifestSearch(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const body = await this.parseSearchBody(req);
    const { needle, exact } = wingetSearchCriteria(body);
    const limit = body.MaximumResults ?? WINGET_SEARCH_DEFAULT_LIMIT;

    const results: WingetSearchResult[] = [];
    let offset = 0;
    let total = 0;
    // The data-layer search is a coarse full-text prefilter; `wingetMatches`
    // applies the winget MatchType (Exact vs substring) over the reconstructed
    // PackageIdentifier + PackageName before a row is admitted to the result.
    do {
      const { packages: rows, total: totalPackages } = await ctx.data.packages.search({
        text: needle,
        from: offset,
        size: WINGET_SEARCH_PACKAGE_BATCH_SIZE,
      });
      total = totalPackages;
      // Advance the page cursor by exactly the rows consumed. A page shorter than
      // the batch size is the last one; an empty page ends the loop. This both
      // pages correctly and guarantees termination (offset strictly increases on
      // every non-empty page, so `offset >= total` is eventually reached).
      if (rows.length === 0) break;
      offset += rows.length;
      const versionsByPackageId = await ctx.data.versions.listLiveForPackages(rows, {
        orderByCreated: "asc",
      });
      for (const pkg of rows) {
        if (results.length >= limit) break;
        const stored = (versionsByPackageId.get(pkg.id) ?? []).flatMap((row) => {
          const metadata = parseWingetVersionMeta(row.metadata);
          return metadata ? [{ version: row.version, metadata }] : [];
        });
        const newest = stored[stored.length - 1];
        if (!newest) continue;
        const identifier = this.identifierFor(pkg.name, newest.metadata);
        if (!wingetMatches(needle, [identifier, newest.metadata.packageName], { exact })) continue;
        results.push(
          buildWingetSearchResult({
            packageIdentifier: identifier,
            packageName: newest.metadata.packageName,
            publisher: newest.metadata.publisher,
            versions: stored.map((entry) => entry.version),
          }),
        );
      }
    } while (offset < total && results.length < limit);

    // winget expects HTTP 204 (no body) when nothing matches.
    if (results.length === 0) return new Response(null, { status: 204 });
    return Response.json(buildWingetSearchResponse(results));
  }

  /**
   * Recover the published PackageIdentifier casing. Package rows are stored
   * lowercased; `Publisher.Package` casing is reconstructed from the version
   * metadata's publisher + packageName when they reproduce the stored name.
   */
  private identifierFor(storedName: string, metadata: WingetVersionMeta): string {
    const candidate = `${metadata.publisher}.${metadata.packageName}`;
    return candidate.toLowerCase() === storedName.toLowerCase() ? candidate : storedName;
  }

  private async parseSearchBody(req: Request) {
    let json: unknown = {};
    const text = await req.text();
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        throw Errors.manifestInvalid({ reason: "invalid manifestSearch body" });
      }
    }
    return parseRegistryInput(WingetSearchRequestSchema, json, {
      code: "MANIFEST_INVALID",
      message: "invalid manifestSearch request",
    });
  }

  private async download(
    packageIdentifierRaw: string,
    versionRaw: string,
    filenameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const packageIdentifier = parsePackageIdentifier(packageIdentifierRaw);
    const version = parseVersion(versionRaw);
    const filename = parseRegistryInput(WingetFilenameSchema, filenameRaw, {
      code: "NAME_INVALID",
      message: "invalid installer filename",
    });
    const pkg = await ctx.data.packages.findByName(packageIdentifier.toLowerCase());
    if (!pkg) return this.notFoundEnvelope();
    const row = await ctx.data.versions.findLive(pkg, version);
    const metadata = parseWingetVersionMeta(row?.metadata);
    if (!metadata) return this.notFoundEnvelope();
    if (metadata.filename !== filename) return this.notFoundEnvelope();
    return serveRegistryBlob(ctx, {
      digest: metadata.installerDigest,
      kind: "generic_file",
      scope: wingetInstallerScope(packageIdentifier, version, filename),
      contentType: "application/octet-stream",
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  private async publish(
    packageIdentifierRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return handleWingetPublish(packageIdentifierRaw, req, ctx);
  }
}

export const wingetRegistryPlugin: RegistryPlugin = new WingetAdapter();
