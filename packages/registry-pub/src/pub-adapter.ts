import {
  createRegistryAdapterPlugin,
  type RegistryRequestContext,
  registryAdapter,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { pubBadRequest, pubNotFound } from "./pub-errors";
import { buildPubPackageListing, buildPubVersionEntry, type PubVersionEntry } from "./pub-metadata";
import { pubBlobScope } from "./pub-publish";
import { handlePubUpload } from "./pub-upload-lifecycle";
import {
  PubArchiveFileSchema,
  PubPackageNameSchema,
  PubVersionSchema,
  parsePubVersionMeta,
} from "./pub-validation";

const PUB_JSON_CONTENT_TYPE = "application/vnd.pub.v2+json";

function pubJson(body: unknown, init: ResponseInit = {}): Response {
  const response = Response.json(body, init);
  response.headers.set("content-type", PUB_JSON_CONTENT_TYPE);
  return response;
}

/** Validate a path param against a Zod schema, returning a pub-shaped 400 on failure. */
function parsePubParam<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  value: string,
  message: string,
): { ok: true; value: T } | { ok: false; response: Response } {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, response: pubBadRequest(message) };
  return { ok: true, value: parsed.data };
}

/**
 * Dart's `pub` Hosted Pub Repository API (repository-spec-v2). Serves the version
 * listing + single-version metadata, the archive download, and the pub 3-step
 * publish flow.
 */
class PubAdapterState {
  archiveUrlContext(ctx: RegistryRequestContext): { baseUrl: string; mountPath: string } {
    return { baseUrl: ctx.baseUrl, mountPath: ctx.repo.mountPath };
  }

  async storedEntries(
    packageName: string,
    ctx: RegistryRequestContext,
  ): Promise<PubVersionEntry[]> {
    const pkg = await ctx.data.packages.findByName(packageName);
    if (!pkg) return [];
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" });
    const { baseUrl, mountPath } = this.archiveUrlContext(ctx);
    return rows.flatMap((row) => {
      const metadata = parsePubVersionMeta(row.metadata);
      if (!metadata) return [];
      return [
        buildPubVersionEntry({
          packageName,
          version: row.version,
          metadata,
          baseUrl,
          mountPath,
        }),
      ];
    });
  }

  async listing(pkgRaw: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const name = parsePubParam(PubPackageNameSchema, pkgRaw, "invalid Pub package name");
    if (!name.ok) return name.response;
    const packageName = name.value;
    const entries = await this.storedEntries(packageName, ctx);
    const listing = buildPubPackageListing({ packageName, versions: entries });
    if (!listing) return pubNotFound(`package ${packageName} not found`);
    return textResponseWithEtag(req, JSON.stringify(listing), {
      "content-type": PUB_JSON_CONTENT_TYPE,
    });
  }

  async version(
    pkgRaw: string,
    versionRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const name = parsePubParam(PubPackageNameSchema, pkgRaw, "invalid Pub package name");
    if (!name.ok) return name.response;
    const ver = parsePubParam(PubVersionSchema, versionRaw, "invalid package version");
    if (!ver.ok) return ver.response;
    const packageName = name.value;
    const version = ver.value;
    const pkg = await ctx.data.packages.findByName(packageName);
    if (!pkg) return pubNotFound(`package ${packageName} not found`);
    const row = await ctx.data.versions.findLive(pkg, version);
    const metadata = parsePubVersionMeta(row?.metadata);
    if (!metadata) return pubNotFound(`version ${version} of package ${packageName} not found`);
    const { baseUrl, mountPath } = this.archiveUrlContext(ctx);
    return textResponseWithEtag(
      req,
      JSON.stringify(buildPubVersionEntry({ packageName, version, metadata, baseUrl, mountPath })),
      { "content-type": PUB_JSON_CONTENT_TYPE },
    );
  }

  async download(fileRaw: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const parsed = parsePubParam(PubArchiveFileSchema, fileRaw, "invalid archive filename");
    if (!parsed.ok) return parsed.response;
    const file = parsed.value;
    const split = splitArchiveFile(file);
    if (!split) return pubNotFound("archive not found");
    const pkg = await ctx.data.packages.findByName(split.packageName);
    if (!pkg) return pubNotFound(`archive ${file} not found`);
    const row = await ctx.data.versions.findLive(pkg, split.version);
    const digest = parsePubVersionMeta(row?.metadata)?.archiveDigest;
    if (!digest) return pubNotFound(`archive ${file} not found`);
    return serveRegistryBlob(ctx, {
      digest,
      kind: "pub_archive",
      scope: pubBlobScope(split.packageName, split.version),
      contentType: "application/gzip",
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  publishNew(ctx: RegistryRequestContext): Response {
    const url = `${ctx.baseUrl}/${ctx.repo.mountPath}/api/packages/versions/newUpload`;
    return pubJson({ url, fields: {} });
  }

  publishUpload(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handlePubUpload(req, ctx);
  }

  publishFinish(): Response {
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
  if (!PubPackageNameSchema.safeParse(packageName).success) return null;
  if (!PubVersionSchema.safeParse(version).success) return null;
  return { packageName, version };
}

function pubDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const parsed = parsePubVersionMeta(metadata);
  const deps = parsed?.pubspec.dependencies;
  if (!deps) return {};
  return Object.fromEntries(Object.entries(deps).map(([name, range]) => [name, String(range)]));
}

const pubDefinition = registryAdapter("pub")
  .stateClass(PubAdapterState)
  .module((module) =>
    module
      .displayName("Pub")
      .mount("pub")
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("listing", "version")
      .compressibleContentTypes(PUB_JSON_CONTENT_TYPE),
  )
  .scan((scan) =>
    scan
      .osvEcosystem("Pub")
      .purlType("pub")
      .dependencies(pubDependencyGraph)
      .referencedDigestPaths("archiveDigest"),
  )
  .bearerAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "file",
        normalize: (file) => {
          if (!file.endsWith(".tar.gz")) return null;
          const parsed = PubArchiveFileSchema.safeParse(file);
          if (!parsed.success) return null;
          const split = splitArchiveFile(parsed.data);
          return split ? pubBlobScope(split.packageName, split.version) : null;
        },
        packageName: ({ params }) => {
          if (!params.file) return undefined;
          const parsed = PubArchiveFileSchema.safeParse(params.file);
          if (!parsed.success) return undefined;
          return splitArchiveFile(parsed.data)?.packageName;
        },
      }),
      p.packageRule({ param: "package", normalize: (pkg) => pkg.toLowerCase() }),
    ]),
  )
  .routes((route) => [
    route
      .get("/api/packages/versions/new", "publishNew")
      .calls((state, { ctx }) => state.publishNew(ctx)),
    route
      .post("/api/packages/versions/newUpload", "publishUpload")
      .calls((state, { req, ctx }) => state.publishUpload(req, ctx)),
    route
      .get("/api/packages/versions/newUploadFinish", "publishFinish")
      .calls((state) => state.publishFinish()),
    route
      .get("/api/packages/:package/versions/:version", "version")
      .calls((state, { params, req, ctx }) =>
        state.version(params.package, params.version, req, ctx),
      ),
    route
      .get("/api/packages/:package", "listing")
      .calls((state, { params, req, ctx }) => state.listing(params.package, req, ctx)),
    route
      .get("/api/archives/:file", "download")
      .calls((state, { params, req, ctx }) => state.download(params.file, req, ctx)),
  ]);

export class PubAdapter extends pubDefinition.adapterClass() {}
export const pubRegistryPlugin = createRegistryAdapterPlugin(PubAdapter);
