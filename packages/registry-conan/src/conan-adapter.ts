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
  conanJsonResponse,
  conanSearchPatternToRegExp,
  packageVersionKey,
  parseConanInfo,
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
  // `virtualizable` only: revision-addressed reads are satisfied by the agnostic
  // per-member fan-out. `proxyable` is intentionally NOT declared — there is no
  // proxyIngest implementation, so proxy-repo creation (gated on adapter.proxyIngest)
  // would be rejected; advertising the flag would be dishonest.
  readonly capabilities = registryCapabilities("virtualizable");
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
        "recipeSearch",
        "packageConfigSearch",
        "packageRevisionSearch",
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
      // The real Conan v2 client issues authenticate as a GET (HTTP Basic ->
      // token text); we keep a POST alias for tolerance with other tooling.
      route.get("/v2/users/authenticate", "authenticate", ({ req, ctx }) =>
        conanAuthenticate(req, ctx),
      ),
      route.post("/v2/users/authenticate", "authenticatePost", ({ req, ctx }) =>
        conanAuthenticate(req, ctx),
      ),
      route.get("/v2/users/check_credentials", "checkCredentials", ({ ctx }) =>
        conanCheckCredentials(ctx),
      ),
      // ── recipe search ────────────────────────────────────────────────────────
      // `GET /v2/conans/search?q=<glob>` drives `conan search <pattern> -r`. It is
      // a single segment after `conans`, so it can never be shadowed by the
      // 4-segment `.../:name/:version/:user/:channel/...` recipe routes.
      route.get(
        "/v2/conans/search",
        "recipeSearch",
        ({ req, ctx }) => this.recipeSearch(req, ctx),
        { searchable: true },
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
      // ── package-configuration search ─────────────────────────────────────────
      // `GET .../revisions/:rrev/search` enumerates the binary package_ids under a
      // specific recipe revision, returning each one's settings/options/requires.
      route.get(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/search",
        "packageRevisionSearch",
        ({ params, ctx }) =>
          this.packageConfigSearch(
            parseReference(params.name, params.version, params.user, params.channel),
            params.rrev,
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
      // `GET .../channel/search` enumerates the binary package_ids of a recipe's
      // latest recipe revision (`conan search <ref>:* -r`). `search` is a distinct
      // literal segment from the `latest`/`revisions` siblings, so no shadowing.
      route.get(
        "/v2/conans/:name/:version/:user/:channel/search",
        "packageConfigSearch",
        ({ params, ctx }) =>
          this.packageConfigSearch(
            parseReference(params.name, params.version, params.user, params.channel),
            undefined,
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
    return conanJsonResponse({
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
    return conanJsonResponse({ revision: latest.rrev, time: latest.time });
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
    return conanJsonResponse(buildConanFilesResponse(meta.files));
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
    return conanJsonResponse({
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
    return conanJsonResponse({ revision: latest.prev, time: latest.time });
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
    return conanJsonResponse(buildConanFilesResponse(meta.files));
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
      blocked: () =>
        conanJsonResponse({ error: "artifact blocked by scan policy" }, { status: 403 }),
      missing: () => notFound(),
    });
  }

  /**
   * GET /v2/conans/search?q=<glob> — recipe search. Returns Conan's
   * `{ "results": ["name/version@user/channel", ...] }`, honouring the `?q=` glob
   * (`*`/`?` wildcards) and the optional `?ignorecase=` flag. With no pattern all
   * recipes are returned. The package names stored in this module are already the
   * canonical `name/version@user/channel` references.
   */
  private async recipeSearch(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const url = new URL(req.url);
    const pattern = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "*";
    const ignoreCase = url.searchParams.get("ignorecase") !== "False";
    const matcher = conanSearchPatternToRegExp(pattern, ignoreCase);
    const names = await ctx.data.packages.listNames();
    const results = names
      .map((row) => row.name)
      .filter((name) => matcher.test(name))
      .sort();
    return conanJsonResponse({ results });
  }

  /**
   * GET .../search and GET .../revisions/:rrev/search — package-configuration
   * search. Enumerates the binary package_ids under a recipe revision (the latest
   * recipe revision when no rrev is given), returning each one's
   * `{ settings, options, requires }` parsed from its stored `conaninfo.txt`.
   * Shape: `{ "<package_id>": { settings, options, requires } }`.
   */
  private async packageConfigSearch(
    reference: ConanReference,
    rrevRaw: string | undefined,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = await this.findRecipe(ctx, reference);
    if (!pkg) return notFound();
    let rrev: string;
    if (rrevRaw === undefined) {
      const [latest] = await this.revisionsOfKind(ctx, pkg, "recipe");
      if (!latest) return notFound();
      rrev = latest.rrev;
    } else {
      rrev = parseRevision(rrevRaw);
    }
    const referenceName = referenceToPackageName(reference);
    // Newest package revision per package_id under this recipe revision.
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "desc" });
    const seen = new Set<string>();
    const out: Record<
      string,
      { settings: Record<string, string>; options: Record<string, string>; requires: string[] }
    > = {};
    for (const row of rows) {
      const meta = parseConanRevisionMeta(row.metadata);
      if (meta?.kind !== "package" || meta.rrev !== rrev || !meta.packageId || !meta.prev) {
        continue;
      }
      if (seen.has(meta.packageId)) continue;
      seen.add(meta.packageId);
      const info = meta.files["conaninfo.txt"];
      if (!info) {
        out[meta.packageId] = { settings: {}, options: {}, requires: [] };
        continue;
      }
      const scope = conanFileScope({
        reference: referenceName,
        rrev,
        packageId: meta.packageId,
        prev: meta.prev,
        filename: "conaninfo.txt",
      });
      const blob = await ctx.data.content.getBlobRef({
        digest: info.blobDigest,
        kind: CONAN_FILE_KIND,
        scope,
      });
      if (!blob) {
        out[meta.packageId] = { settings: {}, options: {}, requires: [] };
        continue;
      }
      const text = await new Response(blob.get()).text();
      out[meta.packageId] = parseConanInfo(text);
    }
    return conanJsonResponse(out);
  }
}

function notFound(): Response {
  return conanJsonResponse({ error: "Not Found" }, { status: 404 });
}

export const conanRegistryPlugin: RegistryPlugin = new ConanAdapter();
