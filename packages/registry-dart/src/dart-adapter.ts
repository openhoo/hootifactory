import {
  bearerAuthChallenge,
  delegateRegistryPlugin,
  type HttpMethod,
  type Permission,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { dartBadRequest, dartNotFound } from "./dart-errors";
import {
  buildDartPackageListing,
  buildDartVersionEntry,
  type DartVersionEntry,
} from "./dart-metadata";
import { dartBlobScope } from "./dart-publish";
import { handleDartUpload } from "./dart-upload-lifecycle";
import {
  DartArchiveFileSchema,
  DartPackageNameSchema,
  DartVersionSchema,
  parseDartVersionMeta,
} from "./dart-validation";

const PUB_JSON_CONTENT_TYPE = "application/vnd.pub.v2+json";

function pubJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", PUB_JSON_CONTENT_TYPE);
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** Validate a path param against a Zod schema, returning a pub-shaped 400 on failure. */
function parsePubParam<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  value: string,
  message: string,
): { ok: true; value: T } | { ok: false; response: Response } {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, response: dartBadRequest(message) };
  return { ok: true, value: parsed.data };
}

/**
 * Dart `pub` Hosted Pub Repository API (repository-spec-v2). Serves the version
 * listing + single-version metadata, the archive download, and the pub 3-step
 * publish flow.
 */
export class DartAdapter implements RegistryPlugin {
  readonly id = "dart" as const;
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = () => bearerAuthChallenge();

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Dart",
      mountSegment: "dart",
      errorResponseKind: "singleError",
      compressibleHandlers: ["listing", "version"],
      compressibleContentTypes: [PUB_JSON_CONTENT_TYPE],
      scan: {
        defaultOsvEcosystem: "Pub",
        dependencyGraph: ({ metadata }) => ({
          deps: dartDependencyGraph(metadata),
          osvEcosystem: "Pub",
          purlType: "pub",
        }),
        referencedDigests: (metadata) =>
          typeof metadata.archiveDigest === "string" ? [metadata.archiveDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      route.get("/api/packages/versions/new", "publishNew", ({ ctx }) => this.publishNew(ctx)),
      route.post("/api/packages/versions/newUpload", "publishUpload", ({ req, ctx }) =>
        this.publishUpload(req, ctx),
      ),
      route.get("/api/packages/versions/newUploadFinish", "publishFinish", () =>
        this.publishFinish(),
      ),
      route.get("/api/packages/:package/versions/:version", "version", ({ params, req, ctx }) =>
        this.version(params.package, params.version, req, ctx),
      ),
      route.get("/api/packages/:package", "listing", ({ params, req, ctx }) =>
        this.listing(params.package, req, ctx),
      ),
      route.get("/api/archives/:file", "download", ({ params, req, ctx }) =>
        this.download(params.file, req, ctx),
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
    const pkg = match?.params.package;
    const file = match?.params.file;
    if (file?.endsWith(".tar.gz")) {
      const parsed = DartArchiveFileSchema.safeParse(file);
      if (parsed.success) {
        const split = splitArchiveFile(parsed.data);
        if (split) {
          return {
            ...permission,
            resource: {
              type: "artifact",
              packageName: split.packageName,
              artifactRef: dartBlobScope(split.packageName, split.version),
            },
          };
        }
      }
    }
    if (pkg) {
      return { ...permission, resource: { type: "package", packageName: pkg.toLowerCase() } };
    }
    return permission;
  }

  handle = this.delegate.handle;

  private archiveUrlContext(ctx: RegistryRequestContext): { baseUrl: string; mountPath: string } {
    return { baseUrl: ctx.baseUrl, mountPath: ctx.repo.mountPath };
  }

  private async storedEntries(
    packageName: string,
    ctx: RegistryRequestContext,
  ): Promise<DartVersionEntry[]> {
    const pkg = await ctx.data.packages.findByName(packageName);
    if (!pkg) return [];
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" });
    const { baseUrl, mountPath } = this.archiveUrlContext(ctx);
    return rows.flatMap((row) => {
      const metadata = parseDartVersionMeta(row.metadata);
      if (!metadata) return [];
      return [
        buildDartVersionEntry({
          packageName,
          version: row.version,
          metadata,
          baseUrl,
          mountPath,
        }),
      ];
    });
  }

  private async listing(
    pkgRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const name = parsePubParam(DartPackageNameSchema, pkgRaw, "invalid Dart package name");
    if (!name.ok) return name.response;
    const packageName = name.value;
    const entries = await this.storedEntries(packageName, ctx);
    const listing = buildDartPackageListing({ packageName, versions: entries });
    if (!listing) return dartNotFound(`package ${packageName} not found`);
    return textResponseWithEtag(req, JSON.stringify(listing), {
      "content-type": PUB_JSON_CONTENT_TYPE,
    });
  }

  private async version(
    pkgRaw: string,
    versionRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const name = parsePubParam(DartPackageNameSchema, pkgRaw, "invalid Dart package name");
    if (!name.ok) return name.response;
    const ver = parsePubParam(DartVersionSchema, versionRaw, "invalid package version");
    if (!ver.ok) return ver.response;
    const packageName = name.value;
    const version = ver.value;
    const pkg = await ctx.data.packages.findByName(packageName);
    if (!pkg) return dartNotFound(`package ${packageName} not found`);
    const row = await ctx.data.versions.findLive(pkg, version);
    const metadata = parseDartVersionMeta(row?.metadata);
    if (!metadata) return dartNotFound(`version ${version} of package ${packageName} not found`);
    const { baseUrl, mountPath } = this.archiveUrlContext(ctx);
    return textResponseWithEtag(
      req,
      JSON.stringify(buildDartVersionEntry({ packageName, version, metadata, baseUrl, mountPath })),
      { "content-type": PUB_JSON_CONTENT_TYPE },
    );
  }

  private async download(
    fileRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const parsed = parsePubParam(DartArchiveFileSchema, fileRaw, "invalid archive filename");
    if (!parsed.ok) return parsed.response;
    const file = parsed.value;
    const split = splitArchiveFile(file);
    if (!split) return dartNotFound("archive not found");
    const pkg = await ctx.data.packages.findByName(split.packageName);
    if (!pkg) return dartNotFound(`archive ${file} not found`);
    const row = await ctx.data.versions.findLive(pkg, split.version);
    const digest = parseDartVersionMeta(row?.metadata)?.archiveDigest;
    if (!digest) return dartNotFound(`archive ${file} not found`);
    return serveRegistryBlob(ctx, {
      digest,
      kind: "dart_archive",
      scope: dartBlobScope(split.packageName, split.version),
      contentType: "application/gzip",
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  private publishNew(ctx: RegistryRequestContext): Response {
    const url = `${ctx.baseUrl}/${ctx.repo.mountPath}/api/packages/versions/newUpload`;
    return pubJson({ url, fields: {} });
  }

  private publishUpload(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleDartUpload(req, ctx);
  }

  private publishFinish(): Response {
    return pubJson({ success: { message: "package published" } });
  }
}

/** Split `<package>-<version>.tar.gz` into a valid package name + version, or null. */
function splitArchiveFile(file: string): { packageName: string; version: string } | null {
  const stem = file.slice(0, -".tar.gz".length);
  const dash = stem.indexOf("-");
  if (dash <= 0) return null;
  const packageName = stem.slice(0, dash);
  const version = stem.slice(dash + 1);
  if (!DartPackageNameSchema.safeParse(packageName).success) return null;
  if (!DartVersionSchema.safeParse(version).success) return null;
  return { packageName, version };
}

function dartDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const parsed = parseDartVersionMeta(metadata);
  const deps = parsed?.pubspec.dependencies;
  if (!deps) return {};
  return Object.fromEntries(Object.entries(deps).map(([name, range]) => [name, String(range)]));
}

export const dartRegistryPlugin: RegistryPlugin = new DartAdapter();
