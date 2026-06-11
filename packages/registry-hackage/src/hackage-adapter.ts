import {
  Errors,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  registryAdapter,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import {
  cabalUrl as buildCabalUrl,
  buildPackageSummary,
  tarballUrl as buildTarballUrl,
  compareHackageVersions,
  type HackagePreferredVersions,
  type HackageVersionList,
} from "./hackage-metadata";
import { hackageBlobScope, handleHackagePublish } from "./hackage-publish-lifecycle";
import { buildIndexTar, buildIndexTarGz, type IndexEntry } from "./hackage-tarball";
import {
  HackageNameSchema,
  type HackageVersionMeta,
  HackageVersionSchema,
  parseHackageVersionMeta,
  sdistFilename,
  splitPackageId,
} from "./hackage-validation";

/** The hackage-security (secure-repo) incremental index, gzip-compressed. */
const INDEX_PATH = "/01-index.tar.gz";
/** The same incremental index, uncompressed (hackage-security range/incremental reads). */
const INDEX_PATH_PLAIN = "/01-index.tar";
/** The legacy (non-secure `secure: False` repo) index filename, gzip-compressed. */
const LEGACY_INDEX_PATH = "/00-index.tar.gz";

function parseName(name: string): string {
  return parseRegistryInput(HackageNameSchema, name, {
    code: "NAME_INVALID",
    message: "invalid Hackage package name",
  });
}

/**
 * Hackage (the Haskell package repository). Serves the package index tarball
 * (regenerated from live versions) as `01-index.tar.gz` (secure), `01-index.tar`
 * (uncompressed) and `00-index.tar.gz` (legacy), per-package version lists,
 * per-version summaries, optional preferred-versions, and the sdist tarball /
 * `.cabal` downloads. Publish is `POST /packages/` (the multipart upload that
 * `cabal upload` sends) or `PUT /package/<name>-<version>`; either way the
 * accepted `.cabal` fields (name, version, build-depends, …) are parsed out of
 * the uploaded sdist and persisted.
 */
class HackageAdapterState {
  /**
   * The package index tarball, regenerated from live versions. Served gzipped at
   * `01-index.tar.gz` (secure) and `00-index.tar.gz` (legacy), and uncompressed
   * at `01-index.tar` (hackage-security incremental reads).
   */
  async index(
    req: Request,
    ctx: RegistryRequestContext,
    format: "gz" | "tar" = "gz",
  ): Promise<Response> {
    const entries = await this.indexEntries(ctx);
    const body = format === "tar" ? buildIndexTar(entries) : buildIndexTarGz(entries);
    const contentType = format === "tar" ? "application/x-tar" : "application/gzip";
    const etag = `"${new Bun.CryptoHasher("sha1").update(body).digest("hex")}"`;
    if (ifNoneMatch(req, etag)) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(body, {
      headers: { "content-type": contentType, etag },
    });
  }

  /** Collect the index entries (`<name>/<version>/<name>.cabal`) in deterministic order. */
  private async indexEntries(ctx: RegistryRequestContext): Promise<IndexEntry[]> {
    const names = await ctx.data.packages.listNames();
    const entries: IndexEntry[] = [];
    // Deterministic ordering so the body (and ETag) is stable across requests.
    for (const { name } of [...names].sort((a, b) => a.name.localeCompare(b.name))) {
      const pkg = await ctx.data.packages.findByName(name);
      if (!pkg) continue;
      const metas = await this.liveMetas(ctx, pkg);
      for (const meta of metas) {
        entries.push({
          path: `${meta.name}/${meta.version}/${meta.name}.cabal`,
          cabal: meta.cabal,
        });
      }
    }
    return entries;
  }

  /** `GET /package/:id` — a version summary (id has a version) or a version list (bare name). */
  async summaryOrVersions(
    idRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const split = splitPackageId(idRaw);
    if (split) return this.summary(split.name, split.version, req, ctx);
    // No version suffix: treat the id as a bare package name → version list.
    const name = parseName(idRaw);
    return this.versions(name, req, ctx);
  }

  /** `GET /package/<name>-<version>` — the per-version package summary. */
  private async summary(
    name: string,
    version: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const row = await ctx.data.versions.findLive(pkg, version);
    const meta = parseHackageVersionMeta(row?.metadata);
    if (!meta) return new Response("Not Found", { status: 404 });
    const summary = buildPackageSummary(meta, {
      tarballUrl: buildTarballUrl(ctx.baseUrl, ctx.repo.mountPath, name, version),
      cabalUrl: buildCabalUrl(ctx.baseUrl, ctx.repo.mountPath, name, version),
    });
    return textResponseWithEtag(req, JSON.stringify(summary), {
      "content-type": "application/json; charset=utf-8",
    });
  }

  /** `GET /package/<name>` — the list of live versions for a package. */
  private async versions(
    name: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const metas = await this.liveMetas(ctx, pkg);
    if (metas.length === 0) return new Response("Not Found", { status: 404 });
    const versions = metas.map((meta) => meta.version).sort((a, b) => compareHackageVersions(a, b));
    const body: HackageVersionList = { name, versions };
    return textResponseWithEtag(req, JSON.stringify(body), {
      "content-type": "application/json; charset=utf-8",
    });
  }

  /** `GET /package/:id/:file` — serve the sdist tarball or the stored `.cabal`. */
  async download(
    idRaw: string,
    fileRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const split = splitPackageId(idRaw);
    if (!split) throw Errors.nameInvalid("invalid Hackage package id");
    const { name, version } = split;
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const row = await ctx.data.versions.findLive(pkg, version);
    const meta = parseHackageVersionMeta(row?.metadata);
    if (!meta) return new Response("Not Found", { status: 404 });

    // Route params arrive already percent-decoded from the router; decoding
    // again would double-decode and could throw on a literal `%` (→ 500).
    const file = fileRaw;
    if (file === `${name}.cabal`) {
      return textResponseWithEtag(req, meta.cabal, {
        "content-type": "text/plain; charset=utf-8",
      });
    }
    if (file === sdistFilename(name, version)) {
      return serveRegistryBlob(ctx, {
        digest: meta.blobDigest,
        kind: "hackage_sdist",
        scope: hackageBlobScope(name, version),
        contentType: "application/gzip",
        redirect: req.method === "GET",
        blocked: () => new Response("blocked by scan policy", { status: 403 }),
      });
    }
    return new Response("Not Found", { status: 404 });
  }

  async publish(idRaw: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const split = splitPackageId(idRaw);
    if (!split) throw Errors.nameInvalid("invalid Hackage package id");
    // Re-validate the parts so a malformed name/version surfaces a 400.
    parseName(split.name);
    parseRegistryInput(HackageVersionSchema, split.version, {
      code: "NAME_INVALID",
      message: "invalid Hackage version",
    });
    return handleHackagePublish(split, req, ctx);
  }

  /**
   * `POST /packages/` — the transport `cabal upload` actually uses. The sdist is
   * a multipart `package` field; the name-version is derived from the uploaded
   * `.cabal` (the path carries no id), then validated like the PUT route.
   */
  async publishUpload(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleHackagePublish(null, req, ctx);
  }

  /**
   * `GET /package/:id/preferred-versions` — cabal's solver consults this to skip
   * deprecated/unpreferred versions. We track no preferences, so we serve a
   * permissive (empty) document: all live versions remain eligible. This avoids
   * a 404 that a real client would otherwise hit.
   */
  async preferredVersions(
    idRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const name = parseName(idRaw);
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const metas = await this.liveMetas(ctx, pkg);
    if (metas.length === 0) return new Response("Not Found", { status: 404 });
    // No version is preferred/deprecated; an empty constraint string means
    // "all versions normal" to cabal's solver.
    const body: HackagePreferredVersions = { name, "preferred-versions": [], deprecated: [] };
    return textResponseWithEtag(req, JSON.stringify(body), {
      "content-type": "application/json; charset=utf-8",
    });
  }

  /** All live versions' parsed metadata for a package (oldest first). */
  private async liveMetas(
    ctx: RegistryRequestContext,
    pkg: { id: string; orgId: string; repositoryId: string; name: string },
  ): Promise<HackageVersionMeta[]> {
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" });
    const metas: HackageVersionMeta[] = [];
    for (const row of rows) {
      const meta = parseHackageVersionMeta(row.metadata);
      if (meta) metas.push(meta);
    }
    return metas;
  }
}

function ifNoneMatch(req: Request, etag: string): boolean {
  const header = req.headers.get("if-none-match");
  if (!header) return false;
  return header
    .split(",")
    .map((v) => v.trim())
    .some((v) => v === "*" || v === etag || v === `W/${etag}`);
}

const hackageDefinition = registryAdapter("hackage")
  .stateClass(HackageAdapterState)
  .module((module) =>
    module
      .displayName("Hackage")
      .mount("hackage")
      // No `proxyable`: there is no `proxyIngest` implementation, and proxy
      // repository creation is gated on that handler existing.
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      // Only declared handler ids belong here; the version-list response rides
      // the `summary` handler, so there is no separate `versions` handler.
      .compressibleHandlers("summary", "preferredVersions"),
  )
  .scan({
    defaultOsvEcosystem: "Hackage",
    referencedDigests: (metadata) =>
      typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
  })
  .basicAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "id",
        normalize: (id, { match }) => {
          const split = splitPackageId(id);
          return split &&
            (match.entry.handlerId === "download" || match.entry.handlerId === "publish")
            ? hackageBlobScope(split.name, split.version)
            : null;
        },
        packageName: ({ params }) => (params.id ? splitPackageId(params.id)?.name : undefined),
      }),
      p.packageRule({
        param: "id",
        normalize: (id) =>
          splitPackageId(id)?.name ?? (HackageNameSchema.safeParse(id).success ? id : null),
      }),
    ]),
  )
  .routes((route) => [
    // Literal routes declared before the `/package/:id` catch-alls so they
    // cannot be shadowed (the matcher tries routes in declared order).
    route.get(INDEX_PATH, "index").calls((state, { req, ctx }) => state.index(req, ctx)),
    // Uncompressed index (hackage-security incremental reads) and the legacy
    // `00-index.tar.gz` alias (`secure: False` repos) so an unconfigured or
    // legacy cabal client can complete `cabal update`.
    route
      .get(INDEX_PATH_PLAIN, "indexPlain")
      .calls((state, { req, ctx }) => state.index(req, ctx, "tar")),
    route
      .get(LEGACY_INDEX_PATH, "indexLegacy")
      .calls((state, { req, ctx }) => state.index(req, ctx)),
    // `cabal upload` POSTs the sdist as multipart to `/packages/`; the
    // name-version is read from the uploaded `.cabal`, not from the path.
    route
      .post("/packages/", "publishUpload")
      .calls((state, { req, ctx }) => state.publishUpload(req, ctx)),
    // Per-package preferred-versions consulted by cabal's solver. Declared
    // before `/package/:id/:file` so it is not matched as a `:file` download.
    route
      .get("/package/:id/preferred-versions", "preferredVersions")
      .calls((state, { params, req, ctx }) => state.preferredVersions(params.id, req, ctx)),
    route
      .get("/package/:id/:file", "download")
      .calls((state, { params, req, ctx }) => state.download(params.id, params.file, req, ctx)),
    route
      .get("/package/:id", "summary")
      .calls((state, { params, req, ctx }) => state.summaryOrVersions(params.id, req, ctx)),
    route
      .put("/package/:id", "publish")
      .calls((state, { params, req, ctx }) => state.publish(params.id, req, ctx)),
  ]);

export class HackageAdapter extends hackageDefinition.adapterClass() {}
export const hackageRegistryPlugin: RegistryPlugin = new HackageAdapter();
