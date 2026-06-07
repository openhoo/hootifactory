import {
  basicAuthChallenge,
  delegateRegistryPlugin,
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
} from "@hootifactory/registry";
import { type AlpineVersionMeta, parseAlpineVersionMeta } from "./alpine-meta";
import { ALPINE_APK_KIND, alpineBlobScope, handleAlpinePublish } from "./alpine-publish-lifecycle";
import { AlpineApkFilenameSchema, AlpineArchSchema, isValidAlpineArch } from "./alpine-validation";
import { type ApkIndexEntry, buildApkIndexTarGz } from "./apkindex";

const APKINDEX_NAME = "APKINDEX.tar.gz";

function parseArch(arch: string): string {
  return parseRegistryInput(AlpineArchSchema, arch, {
    code: "NAME_INVALID",
    message: "invalid Alpine architecture",
  });
}

function parseApkFilename(filename: string): string {
  return parseRegistryInput(AlpineApkFilenameSchema, filename, {
    code: "NAME_INVALID",
    message: "invalid .apk filename",
  });
}

/**
 * Alpine (apk) repository. Publishing a `.apk` into `<arch>` parses its
 * `.PKGINFO` and hosts the blob; `GET /<arch>/APKINDEX.tar.gz` returns a freshly
 * regenerated index over the live versions for that arch, and
 * `GET /<arch>/<name>-<version>.apk` serves the stored package blob. The format
 * is virtualizable; like registry-apt/registry-maven it does not implement a
 * proxy ingest, so it does not advertise the proxyable capability.
 */
export class AlpineAdapter implements RegistryPlugin {
  readonly id = "alpine" as const;
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Alpine",
      mountSegment: "alpine",
      errorResponseKind: "singleError",
      compressibleHandlers: [],
      scan: {
        defaultOsvEcosystem: "Alpine",
        referencedDigests: (metadata) =>
          typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // `APKINDEX.tar.gz` is a literal second segment declared before `/:arch/:filename`
      // so the catch-all download route cannot shadow it (matcher tries in order).
      route.get(`/:arch/${APKINDEX_NAME}`, "index", ({ params, req, ctx }) =>
        this.index(params.arch, req, ctx),
      ),
      route.get("/:arch/:filename", "download", ({ params, req, ctx }) =>
        this.download(params.arch, params.filename, req, ctx),
      ),
      route.put("/:arch/:filename", "publishNamed", ({ params, req, ctx }) =>
        this.publish(params.arch, req, ctx, params.filename),
      ),
      route.put("/:arch", "publish", ({ params, req, ctx }) => this.publish(params.arch, req, ctx)),
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
    const arch = match?.params.arch;
    const filename = match?.params.filename;
    // Scope both the download read and the named-publish write to the concrete
    // `<arch>/<filename>` artifact so authorization can restrict either to a path.
    const handlerId = match?.entry?.handlerId;
    if (arch && filename && (handlerId === "download" || handlerId === "publishNamed")) {
      return {
        ...permission,
        resource: { type: "artifact", artifactRef: alpineBlobScope(arch, filename) },
      };
    }
    return permission;
  }

  handle = this.delegate.handle;

  /** `GET /<arch>/APKINDEX.tar.gz` — regenerate the index over the arch's live versions. */
  private async index(
    archRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const arch = parseArch(archRaw);
    const entries = await this.indexEntries(ctx, arch);
    const tarGz = buildApkIndexTarGz(entries);
    const etag = `"${new Bun.CryptoHasher("sha1").update(tarGz).digest("hex")}"`;
    if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers: { etag } });
    return new Response(tarGz, {
      headers: { "content-type": "application/gzip", etag },
    });
  }

  /** `GET /<arch>/<name>-<version>.apk` — serve the stored package blob. */
  private async download(
    archRaw: string,
    filenameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const arch = parseArch(archRaw);
    const filename = parseApkFilename(filenameRaw);
    const meta = await this.findByFilename(ctx, arch, filename);
    if (!meta) return new Response("Not Found", { status: 404 });
    return serveRegistryBlob(ctx, {
      digest: meta.blobDigest,
      kind: ALPINE_APK_KIND,
      scope: alpineBlobScope(arch, filename),
      contentType: "application/vnd.alpine.apk",
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  private async publish(
    archRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
    filenameRaw?: string,
  ): Promise<Response> {
    const arch = parseArch(archRaw);
    // `PUT /:arch/:filename` carries a path segment; reject anything that is not a
    // `.apk` filename before parsing the body. The canonical name is derived from
    // `.PKGINFO`, but authorization on this route is scoped to the URL segment, so
    // we forward it to the handler which rejects a mismatch (confused-deputy guard).
    const urlFilename = filenameRaw !== undefined ? parseApkFilename(filenameRaw) : undefined;
    const result = await handleAlpinePublish(arch, req, ctx, urlFilename);
    return Response.json(result.body, { status: result.status });
  }

  /** Build APKINDEX entries from every live version whose stored arch matches. */
  private async indexEntries(ctx: RegistryRequestContext, arch: string): Promise<ApkIndexEntry[]> {
    const entries: ApkIndexEntry[] = [];
    for (const meta of await this.liveMetaForArch(ctx, arch)) {
      entries.push({
        name: meta.name,
        version: meta.version,
        arch: meta.arch,
        checksum: meta.checksum,
        size: meta.size,
        installedSize: meta.installedSize ?? null,
        description: meta.description ?? null,
        depends: meta.depends ?? [],
        provides: meta.provides ?? [],
      });
    }
    return entries;
  }

  /** Resolve the live version metadata matching `<arch>/<filename>`, if any. */
  private async findByFilename(
    ctx: RegistryRequestContext,
    arch: string,
    filename: string,
  ): Promise<AlpineVersionMeta | null> {
    for (const meta of await this.liveMetaForArch(ctx, arch)) {
      if (meta.filename === filename) return meta;
    }
    return null;
  }

  /** Every live version's metadata across all packages, filtered to one arch. */
  private async liveMetaForArch(
    ctx: RegistryRequestContext,
    arch: string,
  ): Promise<AlpineVersionMeta[]> {
    if (!isValidAlpineArch(arch)) return [];
    const names = await ctx.data.packages.listNames();
    const metas: AlpineVersionMeta[] = [];
    for (const { name } of names) {
      const pkg = await ctx.data.packages.findByName(name);
      if (!pkg) continue;
      for (const row of await ctx.data.versions.listLive(pkg)) {
        const meta = parseAlpineVersionMeta(row.metadata);
        if (meta && meta.arch === arch) metas.push(meta);
      }
    }
    return metas;
  }
}

export const alpineRegistryPlugin: RegistryPlugin = new AlpineAdapter();
