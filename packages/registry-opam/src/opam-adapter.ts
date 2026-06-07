import {
  basicAuthChallenge,
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  ifNoneMatch,
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
  parseOpamVersionMeta,
} from "./opam-validation";

function parsePackageName(name: string): string {
  return parseRegistryInput(OpamPackageNameSchema, name, {
    code: "NAME_INVALID",
    message: "invalid opam package name",
  });
}

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
export class OpamAdapter implements RegistryPlugin {
  readonly id = "opam" as const;
  readonly capabilities = registryCapabilities("proxyable", "virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "opam",
      mountSegment: "opam",
      errorResponseKind: "singleError",
      compressibleHandlers: ["opamFile"],
      scan: {
        defaultOsvEcosystem: undefined,
        referencedDigests: (metadata) =>
          typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // `/index.tar.gz` is a literal segment declared before the `/packages/...`
      // and `/archives/...` routes (the route-matcher tries routes in order).
      route.get("/index.tar.gz", "index", ({ req, ctx }) => this.index(req, ctx)),
      route.get("/packages/:pkg/:nv/opam", "opamFile", ({ params, req, ctx }) =>
        this.opamFile(params.pkg, params.nv, req, ctx),
      ),
      route.get("/archives/:name/:version/:filename", "archive", ({ params, req, ctx }) =>
        this.archive(params.name, params.version, params.filename, req, ctx),
      ),
      route.put("/upload", "publish", ({ req, ctx }) => this.publish(req, ctx)),
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
    if (handlerId === "archive") {
      const name = match?.params.name;
      const version = match?.params.version;
      const filename = match?.params.filename;
      if (name && version && filename && isValidName(name)) {
        return {
          ...permission,
          resource: {
            type: "artifact",
            packageName: name,
            artifactRef: opamBlobScope(name, version, filename),
          },
        };
      }
    }
    if (handlerId === "opamFile") {
      const pkg = match?.params.pkg;
      if (pkg && isValidName(pkg)) {
        return { ...permission, resource: { type: "package", packageName: pkg } };
      }
    }
    return permission;
  }

  handle = this.delegate.handle;

  /** `GET /index.tar.gz` — gzipped tar of the whole repo (repo file + opam files). */
  private async index(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const metas = await this.liveMetas(ctx);
    const tarball = buildOpamIndexTarball(metas, (meta) => this.srcUrl(ctx, meta));
    const etag = `"${new Bun.CryptoHasher("sha1").update(tarball).digest("hex")}"`;
    if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers: { etag } });
    return new Response(tarball, {
      headers: { "content-type": "application/gzip", etag },
    });
  }

  /** `GET /packages/<pkg>/<pkg>.<version>/opam` — the individual opam file. */
  private async opamFile(
    pkgRaw: string,
    nvRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = parsePackageName(pkgRaw);
    // The `<name>.<version>` directory segment must start with `<pkg>.`.
    const prefix = `${pkg}.`;
    if (!nvRaw.startsWith(prefix) || nvRaw.length === prefix.length) throw Errors.notFound();
    const version = parseVersion(nvRaw.slice(prefix.length));
    const pkgRow = await ctx.data.packages.findByName(pkg);
    if (!pkgRow) return new Response("Not Found", { status: 404 });
    const row = await ctx.data.versions.findLive(pkgRow, version);
    const meta = parseOpamVersionMeta(row?.metadata);
    if (!meta) return new Response("Not Found", { status: 404 });
    return textResponseWithEtag(req, buildOpamFile(meta, this.srcUrl(ctx, meta)), {
      "content-type": "text/plain; charset=utf-8",
    });
  }

  /** `GET /archives/<name>/<version>/<filename>` — serve the hosted source archive. */
  private async archive(
    nameRaw: string,
    versionRaw: string,
    filenameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const name = parsePackageName(nameRaw);
    const version = parseVersion(versionRaw);
    const filename = parseRegistryInput(OpamArchiveFilenameSchema, filenameRaw, {
      code: "NAME_INVALID",
      message: "invalid archive filename",
    });
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const row = await ctx.data.versions.findLive(pkg, version);
    const meta = parseOpamVersionMeta(row?.metadata);
    // The requested filename must match the canonical archive this version stored.
    if (!meta || meta.filename !== filename) return new Response("Not Found", { status: 404 });
    return serveRegistryBlob(ctx, {
      digest: meta.blobDigest,
      kind: OPAM_ARCHIVE_KIND,
      scope: opamBlobScope(name, version, filename),
      contentType: "application/gzip",
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  private async publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleOpamPublish(req, ctx);
  }

  /** All live versions' stored opam metadata across every package in the repo. */
  private async liveMetas(ctx: RegistryRequestContext): Promise<OpamVersionMeta[]> {
    const names = await ctx.data.packages.listNames();
    const metas: OpamVersionMeta[] = [];
    // Deterministic ordering so the index bytes (and ETag) are stable.
    for (const { name } of [...names].sort((a, b) => a.name.localeCompare(b.name))) {
      const pkg = await ctx.data.packages.findByName(name);
      if (!pkg) continue;
      const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" });
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

export const opamRegistryPlugin: RegistryPlugin = new OpamAdapter();
