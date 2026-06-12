import {
  bytesResponseWithEtag,
  createRegistryAdapterPlugin,
  Errors,
  parseRegistryInput,
  type RegistryRequestContext,
  type RegistryRouteParamSpec,
  registryAdapter,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { buildOpamFile } from "./opam-file";
import { buildOpamIndexTarball } from "./opam-index";
import {
  handleOpamPublish,
  OPAM_ARCHIVE_KIND,
  opamArchivePath,
  opamBlobScope,
} from "./opam-publish-lifecycle";
import {
  OpamArchiveFilenameSchema,
  OpamPackageNameSchema,
  type OpamVersionMeta,
  OpamVersionSchema,
  opamArchiveMediaType,
  parseOpamVersionMeta,
} from "./opam-validation";

const packageNameParam: RegistryRouteParamSpec = {
  schema: OpamPackageNameSchema,
  code: "NAME_INVALID",
  message: "invalid opam package name",
};

const versionParam: RegistryRouteParamSpec = {
  schema: OpamVersionSchema,
  code: "MANIFEST_INVALID",
  message: "invalid opam version",
};

const archiveFilenameParam: RegistryRouteParamSpec = {
  schema: OpamArchiveFilenameSchema,
  code: "NAME_INVALID",
  message: "invalid archive filename",
};

function parseVersion(version: string): string {
  return parseRegistryInput(OpamVersionSchema, version, {
    code: "MANIFEST_INVALID",
    message: "invalid opam version",
  });
}

/**
 * opam (OCaml) repository. A repo's mount URL is added as an opam repository, and
 * clients fetch `index.tar.gz` (the whole metadata tree) then resolve sources via
 * each opam file's `url.src`. We also expose the individual opam file and the
 * source archive blob over HTTP. Publish is a hootifactory extension (real opam
 * repos are git repos PR'd by hand): a `PUT` of an opam manifest + source archive.
 */
class OpamAdapterState {
  /** `GET /index.tar.gz` — gzipped tar of the whole repo (repo file + opam files). */
  async index(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const metas = await this.liveMetas(ctx);
    const tarball = buildOpamIndexTarball(metas, (meta) => this.srcUrl(ctx, meta));
    return bytesResponseWithEtag(req, tarball, { "content-type": "application/gzip" });
  }

  /** `GET /packages/<pkg>/<pkg>.<version>/opam` — the individual opam file. */
  async opamFile(
    pkg: string,
    nvRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    // The `<name>.<version>` directory segment must start with `<pkg>.`.
    const prefix = `${pkg}.`;
    if (!nvRaw.startsWith(prefix) || nvRaw.length === prefix.length) throw Errors.notFound();
    const version = parseVersion(nvRaw.slice(prefix.length));
    const pkgRow = await ctx.data.packages.findByName(pkg);
    if (!pkgRow) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkgRow, version);
    const meta = parseOpamVersionMeta(row?.metadata);
    if (!meta) throw Errors.notFound();
    return textResponseWithEtag(req, buildOpamFile(meta, this.srcUrl(ctx, meta)), {
      "content-type": "text/plain; charset=utf-8",
    });
  }

  /** `GET /archives/<name>/<version>/<filename>` — serve the hosted source archive. */
  async archive(
    name: string,
    version: string,
    filename: string,
    _req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkg, version);
    const meta = parseOpamVersionMeta(row?.metadata);
    // The requested filename must match the canonical archive this version stored.
    if (!meta || meta.filename !== filename) throw Errors.notFound();
    return serveRegistryBlob(ctx, {
      digest: meta.blobDigest,
      kind: OPAM_ARCHIVE_KIND,
      scope: opamBlobScope(name, version, filename),
      contentType: opamArchiveMediaType(filename),
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  async publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleOpamPublish(req, ctx);
  }

  /** All live versions' stored opam metadata across every package in the repo. */
  private async liveMetas(ctx: RegistryRequestContext): Promise<OpamVersionMeta[]> {
    // Batch the live-version lookup (one `list()` + one `listLiveForPackages()`)
    // instead of an N+1 `findByName()`/`listLive()` per package, since this runs
    // on every `/index.tar.gz` request.
    const pkgs = await ctx.data.packages.list();
    if (pkgs.length === 0) return [];
    const byPackage = await ctx.data.versions.listLiveForPackages(pkgs, {
      orderByCreated: "asc",
    });
    const metas: OpamVersionMeta[] = [];
    // Deterministic ordering so the index bytes (and ETag) are stable.
    for (const pkg of [...pkgs].sort((a, b) => a.name.localeCompare(b.name))) {
      const rows = byPackage.get(pkg.id) ?? [];
      for (const row of rows) {
        const meta = parseOpamVersionMeta(row.metadata);
        if (meta) metas.push(meta);
      }
    }
    return metas;
  }

  /** Absolute URL the opam `url.src` points at for a stored version's archive. */
  private srcUrl(ctx: RegistryRequestContext, meta: OpamVersionMeta): string {
    const path = opamArchivePath(meta.name, meta.version, meta.filename)
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    return `${ctx.baseUrl}/${ctx.repo.mountPath}/${path}`;
  }
}

function isValidName(name: string): boolean {
  return OpamPackageNameSchema.safeParse(name).success;
}

const opamDefinition = registryAdapter("opam")
  .stateClass(OpamAdapterState)
  .module((module) =>
    module
      .displayName("opam")
      .mount("opam")
      // Only `virtualizable` is advertised: this adapter hosts opam repos but
      // performs no upstream fetch, so it wires no `.proxyIngest(...)`.
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("opamFile"),
  )
  .scan({
    defaultOsvEcosystem: undefined,
    referencedDigests: (metadata) =>
      typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
  })
  .basicAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "filename",
        normalize: (filename, { params }) =>
          params.name && params.version && isValidName(params.name)
            ? opamBlobScope(params.name, params.version, filename)
            : null,
        packageName: ({ params }) => params.name,
      }),
      p.packageRule({ param: "pkg", normalize: (pkg) => (isValidName(pkg) ? pkg : null) }),
    ]),
  )
  .routes((route) => [
    // `/index.tar.gz` is a literal segment declared before the `/packages/...`
    // and `/archives/...` routes (the route-matcher tries routes in order).
    route.get("/index.tar.gz", "index").calls((state, { req, ctx }) => state.index(req, ctx)),
    route
      .get("/packages/:pkg/:nv/opam", "opamFile")
      .params({ pkg: packageNameParam })
      .calls((state, { params, req, ctx }) => state.opamFile(params.pkg, params.nv, req, ctx)),
    route
      .get("/archives/:name/:version/:filename", "archive")
      .params({ name: packageNameParam, version: versionParam, filename: archiveFilenameParam })
      .calls((state, { params, req, ctx }) =>
        state.archive(params.name, params.version, params.filename, req, ctx),
      ),
    route.put("/upload", "publish").calls((state, { req, ctx }) => state.publish(req, ctx)),
  ]);

export class OpamAdapter extends opamDefinition.adapterClass() {}
export const opamRegistryPlugin = createRegistryAdapterPlugin(OpamAdapter);
