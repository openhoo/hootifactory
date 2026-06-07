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
  cabalUrl as buildCabalUrl,
  buildPackageSummary,
  tarballUrl as buildTarballUrl,
  compareHackageVersions,
  type HackageVersionList,
} from "./hackage-metadata";
import { hackageBlobScope, handleHackagePublish } from "./hackage-publish-lifecycle";
import { buildIndexTarGz, type IndexEntry } from "./hackage-tarball";
import {
  HackageNameSchema,
  type HackageVersionMeta,
  HackageVersionSchema,
  parseHackageVersionMeta,
  sdistFilename,
  splitPackageId,
} from "./hackage-validation";

const INDEX_PATH = "/01-index.tar.gz";

function parseName(name: string): string {
  return parseRegistryInput(HackageNameSchema, name, {
    code: "NAME_INVALID",
    message: "invalid Hackage package name",
  });
}

/**
 * Hackage (the Haskell package repository). Serves the package index tarball
 * (`01-index.tar.gz`, regenerated from live versions), per-package version lists
 * and per-version summaries, and the sdist tarball / `.cabal` downloads. Publish
 * is `PUT /package/<name>-<version>` of the sdist tarball; the accepted `.cabal`
 * fields (name, version, build-depends, …) are parsed out of it and persisted.
 */
export class HackageAdapter implements RegistryPlugin {
  readonly id = "hackage" as const;
  readonly capabilities = registryCapabilities("proxyable", "virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Hackage",
      mountSegment: "hackage",
      errorResponseKind: "singleError",
      compressibleHandlers: ["summary", "versions"],
      scan: {
        defaultOsvEcosystem: "Hackage",
        referencedDigests: (metadata) =>
          typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // Literal routes declared before the `/package/:id` catch-alls so they
      // cannot be shadowed (the matcher tries routes in declared order).
      route.get(INDEX_PATH, "index", ({ req, ctx }) => this.index(req, ctx)),
      route.get("/package/:id/:file", "download", ({ params, req, ctx }) =>
        this.download(params.id, params.file, req, ctx),
      ),
      route.get("/package/:id", "summary", ({ params, req, ctx }) =>
        this.summaryOrVersions(params.id, req, ctx),
      ),
      route.put("/package/:id", "publish", ({ params, req, ctx }) =>
        this.publish(params.id, req, ctx),
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
    const id = match?.params.id;
    if (!id) return permission;
    const split = splitPackageId(id);
    if (
      split &&
      (match?.entry?.handlerId === "download" || match?.entry?.handlerId === "publish")
    ) {
      return {
        ...permission,
        resource: {
          type: "artifact",
          packageName: split.name,
          artifactRef: hackageBlobScope(split.name, split.version),
        },
      };
    }
    // A `summary` read is keyed to the package name: prefer the name from a
    // `<name>-<version>` id, else treat the bare id as the package name.
    const packageName = split?.name ?? (HackageNameSchema.safeParse(id).success ? id : null);
    if (packageName) {
      return { ...permission, resource: { type: "package", packageName } };
    }
    return permission;
  }

  handle = this.delegate.handle;

  /** `GET /01-index.tar.gz` — the package index tarball, regenerated from live versions. */
  private async index(req: Request, ctx: RegistryRequestContext): Promise<Response> {
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
    const gz = buildIndexTarGz(entries);
    const etag = `"${new Bun.CryptoHasher("sha1").update(gz).digest("hex")}"`;
    if (ifNoneMatch(req, etag)) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(gz, {
      headers: { "content-type": "application/gzip", etag },
    });
  }

  /** `GET /package/:id` — a version summary (id has a version) or a version list (bare name). */
  private async summaryOrVersions(
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
  private async download(
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

    const file = decodeURIComponent(fileRaw);
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

  private async publish(
    idRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
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

export const hackageRegistryPlugin: RegistryPlugin = new HackageAdapter();
