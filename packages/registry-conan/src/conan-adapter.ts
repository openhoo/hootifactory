import {
  delegateRegistryPlugin,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPackageHandle,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryBearerAuthChallenge,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
} from "@hootifactory/registry";
import { conanAuthenticate, conanCheckCredentials, conanPing } from "./conan-auth";
import {
  CONAN_FILE_KIND,
  type ConanFileTarget,
  handleConanFileUpload,
  versionKeyForTarget,
} from "./conan-publish-lifecycle";
import {
  buildConanFilesResponse,
  ConanFilenameSchema,
  ConanPackageIdSchema,
  type ConanReference,
  ConanRevisionSchema,
  ConanSegmentSchema,
  conanFileScope,
  packageVersionKey,
  parseConanRevisionMeta,
  recipeVersionKey,
  referenceToPackageName,
} from "./conan-validation";

const REGISTRY_TOKEN_SERVICE = "hootifactory";

function parseSegment(value: string, what: string): string {
  return parseRegistryInput(ConanSegmentSchema, value, {
    code: "NAME_INVALID",
    message: `invalid Conan ${what}`,
  });
}

function parseRevision(value: string): string {
  return parseRegistryInput(ConanRevisionSchema, value, {
    code: "MANIFEST_INVALID",
    message: "invalid Conan revision",
  });
}

function parsePackageId(value: string): string {
  return parseRegistryInput(ConanPackageIdSchema, value, {
    code: "NAME_INVALID",
    message: "invalid Conan package id",
  });
}

function parseFilename(value: string): string {
  return parseRegistryInput(ConanFilenameSchema, value, {
    code: "NAME_INVALID",
    message: "invalid Conan filename",
  });
}

/** Build a validated recipe reference from the four path segments. */
function parseReference(
  name: string,
  version: string,
  user: string,
  channel: string,
): ConanReference {
  return {
    name: parseSegment(name, "name"),
    version: parseSegment(version, "version"),
    user: parseSegment(user, "user"),
    channel: parseSegment(channel, "channel"),
  };
}

/**
 * Conan v2 REST API for C/C++ recipes and package binaries. Recipes are addressed
 * by `name/version/user/channel` and carry one or more content-hash recipe
 * revisions (rrev); each rrev holds package binaries (package_id), each with their
 * own package revisions (prev). Every transferred file is stored as a CAS blob
 * keyed by reference+revision+filename, modelled as a hootifactory version row.
 */
export class ConanAdapter implements RegistryPlugin {
  readonly id = "conan" as const;
  readonly capabilities = registryCapabilities("proxyable", "virtualizable");
  authChallenge = (perm: Permission, ctx: RegistryRequestContext) =>
    registryBearerAuthChallenge({ ctx, permission: perm, service: REGISTRY_TOKEN_SERVICE });

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Conan",
      mountSegment: "conan",
      acceptsRegistryBearerToken: true,
      errorResponseKind: "singleError",
      compressibleHandlers: [
        "recipeRevisions",
        "recipeLatest",
        "recipeFiles",
        "packageRevisions",
        "packageLatest",
        "packageFiles",
      ],
      scan: {
        defaultOsvEcosystem: "ConanCenter",
        dependencyGraph: () => ({ deps: {}, purlType: "conan" }),
        referencedDigests: (metadata) => {
          const meta = parseConanRevisionMeta(metadata);
          if (!meta) return [];
          return Object.values(meta.files).map((file) => file.blobDigest);
        },
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // ── prelude ────────────────────────────────────────────────────────────
      route.get("/v1/ping", "ping", () => conanPing()),
      route.post("/v2/users/authenticate", "authenticate", ({ req, ctx }) =>
        conanAuthenticate(req, ctx),
      ),
      route.get("/v2/users/check_credentials", "checkCredentials", ({ ctx }) =>
        conanCheckCredentials(ctx),
      ),
      // ── package-binary routes (declared before recipe-file routes so the more
      //     specific `.../packages/...` paths win over `.../files/...`) ─────────
      route.get(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/revisions/:prev/files",
        "packageFiles",
        ({ params, ctx }) =>
          this.packageFiles(
            parseReference(params.name, params.version, params.user, params.channel),
            params.rrev,
            params.pkgid,
            params.prev,
            ctx,
          ),
      ),
      route.get(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/revisions/:prev/files/:filename",
        "packageFileDownload",
        ({ params, req, ctx }) =>
          this.fileDownload(
            {
              reference: parseReference(params.name, params.version, params.user, params.channel),
              rrev: parseRevision(params.rrev),
              packageId: parsePackageId(params.pkgid),
              prev: parseRevision(params.prev),
              filename: parseFilename(params.filename),
            },
            req,
            ctx,
          ),
      ),
      route.put(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/revisions/:prev/files/:filename",
        "packageFileUpload",
        ({ params, req, ctx }) =>
          handleConanFileUpload(
            {
              reference: parseReference(params.name, params.version, params.user, params.channel),
              rrev: parseRevision(params.rrev),
              packageId: parsePackageId(params.pkgid),
              prev: parseRevision(params.prev),
              filename: parseFilename(params.filename),
            },
            req,
            ctx,
          ),
      ),
      route.get(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/latest",
        "packageLatest",
        ({ params, ctx }) =>
          this.packageLatest(
            parseReference(params.name, params.version, params.user, params.channel),
            params.rrev,
            params.pkgid,
            ctx,
          ),
      ),
      route.get(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/revisions",
        "packageRevisions",
        ({ params, ctx }) =>
          this.packageRevisions(
            parseReference(params.name, params.version, params.user, params.channel),
            params.rrev,
            params.pkgid,
            ctx,
          ),
      ),
      // ── recipe-file routes ───────────────────────────────────────────────────
      route.get(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/files",
        "recipeFiles",
        ({ params, ctx }) =>
          this.recipeFiles(
            parseReference(params.name, params.version, params.user, params.channel),
            params.rrev,
            ctx,
          ),
      ),
      route.get(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/files/:filename",
        "recipeFileDownload",
        ({ params, req, ctx }) =>
          this.fileDownload(
            {
              reference: parseReference(params.name, params.version, params.user, params.channel),
              rrev: parseRevision(params.rrev),
              filename: parseFilename(params.filename),
            },
            req,
            ctx,
          ),
      ),
      route.put(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/files/:filename",
        "recipeFileUpload",
        ({ params, req, ctx }) =>
          handleConanFileUpload(
            {
              reference: parseReference(params.name, params.version, params.user, params.channel),
              rrev: parseRevision(params.rrev),
              filename: parseFilename(params.filename),
            },
            req,
            ctx,
          ),
      ),
      // ── recipe-revision routes ───────────────────────────────────────────────
      route.get(
        "/v2/conans/:name/:version/:user/:channel/latest",
        "recipeLatest",
        ({ params, ctx }) =>
          this.recipeLatest(
            parseReference(params.name, params.version, params.user, params.channel),
            ctx,
          ),
      ),
      route.get(
        "/v2/conans/:name/:version/:user/:channel/revisions",
        "recipeRevisions",
        ({ params, ctx }) =>
          this.recipeRevisions(
            parseReference(params.name, params.version, params.user, params.channel),
            ctx,
          ),
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
    const { name, version, user, channel } = match?.params ?? {};
    if (!name || !version || !user || !channel) return permission;
    const packageName = referenceToPackageName({ name, version, user, channel });
    const filename = match?.params.filename;
    const rrev = match?.params.rrev;
    if (filename && rrev) {
      const pkgid = match?.params.pkgid;
      const prev = match?.params.prev;
      const scope = conanFileScope({
        reference: packageName,
        rrev,
        packageId: pkgid,
        prev,
        filename,
      });
      return {
        ...permission,
        resource: { type: "artifact", packageName, artifactRef: scope },
      };
    }
    return { ...permission, resource: { type: "package", packageName } };
  }

  handle = this.delegate.handle;

  private async findRecipe(ctx: RegistryRequestContext, reference: ConanReference) {
    return ctx.data.packages.findByName(referenceToPackageName(reference));
  }

  /** All live revision rows of one kind under a recipe, newest first. */
  private async revisionsOfKind(
    ctx: RegistryRequestContext,
    pkg: RegistryPackageHandle,
    kind: "recipe" | "package",
    pkgScope?: { rrev: string; packageId: string },
  ) {
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "desc" });
    const metas = [];
    for (const row of rows) {
      const meta = parseConanRevisionMeta(row.metadata);
      if (!meta || meta.kind !== kind) continue;
      // Package revisions are scoped to one recipe revision + package id so a
      // listing never bleeds binaries from other recipe revisions.
      if (
        kind === "package" &&
        (meta.rrev !== pkgScope?.rrev || meta.packageId !== pkgScope?.packageId)
      )
        continue;
      metas.push(meta);
    }
    return metas;
  }

  /** GET .../revisions — list recipe revisions newest-first. */
  private async recipeRevisions(
    reference: ConanReference,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = await this.findRecipe(ctx, reference);
    if (!pkg) return notFound();
    const metas = await this.revisionsOfKind(ctx, pkg, "recipe");
    if (metas.length === 0) return notFound();
    return Response.json({
      revisions: metas.map((meta) => ({ revision: meta.rrev, time: meta.time })),
    });
  }

  /** GET .../latest — the newest recipe revision. */
  private async recipeLatest(
    reference: ConanReference,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = await this.findRecipe(ctx, reference);
    if (!pkg) return notFound();
    const [latest] = await this.revisionsOfKind(ctx, pkg, "recipe");
    if (!latest) return notFound();
    return Response.json({ revision: latest.rrev, time: latest.time });
  }

  /** GET .../revisions/:rrev/files — the file map of a recipe revision. */
  private async recipeFiles(
    reference: ConanReference,
    rrevRaw: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const rrev = parseRevision(rrevRaw);
    const pkg = await this.findRecipe(ctx, reference);
    if (!pkg) return notFound();
    const row = await ctx.data.versions.findLive(pkg, recipeVersionKey(rrev));
    const meta = parseConanRevisionMeta(row?.metadata);
    if (meta?.kind !== "recipe") return notFound();
    return Response.json(buildConanFilesResponse(meta.files));
  }

  /** GET .../packages/:pkgid/revisions — package-binary revisions newest-first. */
  private async packageRevisions(
    reference: ConanReference,
    rrevRaw: string,
    pkgidRaw: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const rrev = parseRevision(rrevRaw);
    const pkgid = parsePackageId(pkgidRaw);
    const pkg = await this.findRecipe(ctx, reference);
    if (!pkg) return notFound();
    const metas = await this.revisionsOfKind(ctx, pkg, "package", { rrev, packageId: pkgid });
    if (metas.length === 0) return notFound();
    return Response.json({
      revisions: metas.map((meta) => ({ revision: meta.prev, time: meta.time })),
    });
  }

  /** GET .../packages/:pkgid/latest — the newest package-binary revision. */
  private async packageLatest(
    reference: ConanReference,
    rrevRaw: string,
    pkgidRaw: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const rrev = parseRevision(rrevRaw);
    const pkgid = parsePackageId(pkgidRaw);
    const pkg = await this.findRecipe(ctx, reference);
    if (!pkg) return notFound();
    const [latest] = await this.revisionsOfKind(ctx, pkg, "package", { rrev, packageId: pkgid });
    if (!latest) return notFound();
    return Response.json({ revision: latest.prev, time: latest.time });
  }

  /** GET .../packages/:pkgid/revisions/:prev/files — package-binary file map. */
  private async packageFiles(
    reference: ConanReference,
    rrevRaw: string,
    pkgidRaw: string,
    prevRaw: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const rrev = parseRevision(rrevRaw);
    const pkgid = parsePackageId(pkgidRaw);
    const prev = parseRevision(prevRaw);
    const pkg = await this.findRecipe(ctx, reference);
    if (!pkg) return notFound();
    const row = await ctx.data.versions.findLive(pkg, packageVersionKey(rrev, pkgid, prev));
    const meta = parseConanRevisionMeta(row?.metadata);
    if (meta?.kind !== "package") return notFound();
    return Response.json(buildConanFilesResponse(meta.files));
  }

  /** GET .../files/:filename — serve a stored recipe or package file blob. */
  private async fileDownload(
    target: ConanFileTarget,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = await this.findRecipe(ctx, target.reference);
    if (!pkg) return notFound();
    const version = versionKeyForTarget(target);
    const row = await ctx.data.versions.findLive(pkg, version);
    const meta = parseConanRevisionMeta(row?.metadata);
    const entry = meta?.files[target.filename];
    if (!meta || !entry) return notFound();
    const reference = referenceToPackageName(target.reference);
    const scope = conanFileScope({
      reference,
      rrev: target.rrev,
      packageId: target.packageId,
      prev: target.prev,
      filename: target.filename,
    });
    return serveRegistryBlob(ctx, {
      digest: entry.blobDigest,
      kind: CONAN_FILE_KIND,
      scope,
      contentType: "application/octet-stream",
      redirect: req.method === "GET",
      blocked: () => Response.json({ error: "artifact blocked by scan policy" }, { status: 403 }),
      missing: () => notFound(),
    });
  }
}

function notFound(): Response {
  return Response.json({ error: "Not Found" }, { status: 404 });
}

export const conanRegistryPlugin: RegistryPlugin = new ConanAdapter();
