import {
  createRegistryAdapterPlugin,
  parseRegistryInput,
  type RegistryPackageHandle,
  type RegistryRequestContext,
  registryAdapter,
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
class ConanAdapterState {
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
  async recipeRevisions(reference: ConanReference, ctx: RegistryRequestContext): Promise<Response> {
    const pkg = await this.findRecipe(ctx, reference);
    if (!pkg) return notFound();
    const metas = await this.revisionsOfKind(ctx, pkg, "recipe");
    if (metas.length === 0) return notFound();
    return conanJsonResponse({
      revisions: metas.map((meta) => ({ revision: meta.rrev, time: meta.time })),
    });
  }

  /** GET .../latest — the newest recipe revision. */
  async recipeLatest(reference: ConanReference, ctx: RegistryRequestContext): Promise<Response> {
    const pkg = await this.findRecipe(ctx, reference);
    if (!pkg) return notFound();
    const [latest] = await this.revisionsOfKind(ctx, pkg, "recipe");
    if (!latest) return notFound();
    return conanJsonResponse({ revision: latest.rrev, time: latest.time });
  }

  /** GET .../revisions/:rrev/files — the file map of a recipe revision. */
  async recipeFiles(
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
  async packageRevisions(
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
  async packageLatest(
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
  async packageFiles(
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
  async fileDownload(
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
  async recipeSearch(req: Request, ctx: RegistryRequestContext): Promise<Response> {
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
  async packageConfigSearch(
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

const conanDefinition = registryAdapter("conan")
  .stateClass(ConanAdapterState)
  .module((module) =>
    module
      .displayName("Conan")
      .mount("conan")
      // `virtualizable` only: no proxyIngest/upstream mirror is implemented.
      .capabilities("virtualizable")
      .acceptsRegistryBearerToken()
      .errorResponseKind("singleError")
      .compressibleHandlers(
        "recipeRevisions",
        "recipeLatest",
        "recipeFiles",
        "packageRevisions",
        "packageLatest",
        "packageFiles",
        "recipeSearch",
        "packageConfigSearch",
        "packageRevisionSearch",
      ),
  )
  .scan({
    defaultOsvEcosystem: "ConanCenter",
    dependencyGraph: () => ({ deps: {}, purlType: "conan" }),
    referencedDigests: (metadata) => {
      const meta = parseConanRevisionMeta(metadata);
      if (!meta) return [];
      return Object.values(meta.files).map((file) => file.blobDigest);
    },
  })
  .registryBearerAuth({ service: REGISTRY_TOKEN_SERVICE })
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "filename",
        normalize: (filename, { params }) => {
          const { name, version, user, channel, rrev } = params;
          if (!name || !version || !user || !channel || !rrev) return null;
          return conanFileScope({
            reference: referenceToPackageName({ name, version, user, channel }),
            rrev,
            packageId: params.pkgid,
            prev: params.prev,
            filename,
          });
        },
        packageName: ({ params }) => {
          const { name, version, user, channel } = params;
          return name && version && user && channel
            ? referenceToPackageName({ name, version, user, channel })
            : undefined;
        },
      }),
      p.packageRule({
        param: "channel",
        normalize: (channel, { params }) => {
          const { name, version, user } = params;
          return name && version && user
            ? referenceToPackageName({ name, version, user, channel })
            : null;
        },
      }),
    ]),
  )
  .routes((route) => [
    // ── prelude ────────────────────────────────────────────────────────────
    route.get("/v1/ping", "ping").handle(() => conanPing()),
    route
      .get("/v2/users/authenticate", "authenticate")
      .handle(({ req, ctx }) => conanAuthenticate(req, ctx)),
    route
      .post("/v2/users/authenticate", "authenticatePost")
      .handle(({ req, ctx }) => conanAuthenticate(req, ctx)),
    route
      .get("/v2/users/check_credentials", "checkCredentials")
      .handle(({ ctx }) => conanCheckCredentials(ctx)),
    // ── recipe search ────────────────────────────────────────────────────────
    route
      .searchGet("/v2/conans/search", "recipeSearch")
      .calls((state, { req, ctx }) => state.recipeSearch(req, ctx)),
    // ── package-binary routes ────────────────────────────────────────────────
    route
      .get(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/revisions/:prev/files",
        "packageFiles",
      )
      .calls((state, { params, ctx }) =>
        state.packageFiles(
          parseReference(params.name, params.version, params.user, params.channel),
          params.rrev,
          params.pkgid,
          params.prev,
          ctx,
        ),
      ),
    route
      .get(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/revisions/:prev/files/:filename",
        "packageFileDownload",
      )
      .calls((state, { params, req, ctx }) =>
        state.fileDownload(
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
    route
      .put(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/revisions/:prev/files/:filename",
        "packageFileUpload",
      )
      .handle(({ params, req, ctx }) =>
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
    route
      .get(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/latest",
        "packageLatest",
      )
      .calls((state, { params, ctx }) =>
        state.packageLatest(
          parseReference(params.name, params.version, params.user, params.channel),
          params.rrev,
          params.pkgid,
          ctx,
        ),
      ),
    route
      .get(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/packages/:pkgid/revisions",
        "packageRevisions",
      )
      .calls((state, { params, ctx }) =>
        state.packageRevisions(
          parseReference(params.name, params.version, params.user, params.channel),
          params.rrev,
          params.pkgid,
          ctx,
        ),
      ),
    // ── package-configuration search ─────────────────────────────────────────
    route
      .get(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/search",
        "packageRevisionSearch",
      )
      .calls((state, { params, ctx }) =>
        state.packageConfigSearch(
          parseReference(params.name, params.version, params.user, params.channel),
          params.rrev,
          ctx,
        ),
      ),
    // ── recipe-file routes ───────────────────────────────────────────────────
    route
      .get("/v2/conans/:name/:version/:user/:channel/revisions/:rrev/files", "recipeFiles")
      .calls((state, { params, ctx }) =>
        state.recipeFiles(
          parseReference(params.name, params.version, params.user, params.channel),
          params.rrev,
          ctx,
        ),
      ),
    route
      .get(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/files/:filename",
        "recipeFileDownload",
      )
      .calls((state, { params, req, ctx }) =>
        state.fileDownload(
          {
            reference: parseReference(params.name, params.version, params.user, params.channel),
            rrev: parseRevision(params.rrev),
            filename: parseFilename(params.filename),
          },
          req,
          ctx,
        ),
      ),
    route
      .put(
        "/v2/conans/:name/:version/:user/:channel/revisions/:rrev/files/:filename",
        "recipeFileUpload",
      )
      .handle(({ params, req, ctx }) =>
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
    route
      .get("/v2/conans/:name/:version/:user/:channel/latest", "recipeLatest")
      .calls((state, { params, ctx }) =>
        state.recipeLatest(
          parseReference(params.name, params.version, params.user, params.channel),
          ctx,
        ),
      ),
    route
      .get("/v2/conans/:name/:version/:user/:channel/revisions", "recipeRevisions")
      .calls((state, { params, ctx }) =>
        state.recipeRevisions(
          parseReference(params.name, params.version, params.user, params.channel),
          ctx,
        ),
      ),
    route
      .get("/v2/conans/:name/:version/:user/:channel/search", "packageConfigSearch")
      .calls((state, { params, ctx }) =>
        state.packageConfigSearch(
          parseReference(params.name, params.version, params.user, params.channel),
          undefined,
          ctx,
        ),
      ),
  ]);

export class ConanAdapter extends conanDefinition.adapterClass() {}
export const conanRegistryPlugin = createRegistryAdapterPlugin(ConanAdapter);
