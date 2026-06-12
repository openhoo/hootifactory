import {
  bytesResponseWithEtag,
  createRegistryAdapterPlugin,
  type RegistryRequestContext,
  type RegistryRouteParamSpec,
  registryAdapter,
  serveRegistryBlob,
} from "@hootifactory/registry";
import { type AlpineVersionMeta, parseAlpineVersionMeta } from "./alpine-meta";
import { ALPINE_APK_KIND, alpineBlobScope, handleAlpinePublish } from "./alpine-publish-lifecycle";
import { AlpineApkFilenameSchema, AlpineArchSchema, isValidAlpineArch } from "./alpine-validation";
import { type ApkIndexEntry, buildApkIndexTarGz } from "./apkindex";

const APKINDEX_NAME = "APKINDEX.tar.gz";

const archParam: RegistryRouteParamSpec = {
  schema: AlpineArchSchema,
  code: "NAME_INVALID",
  message: "invalid Alpine architecture",
};

const apkFilenameParam: RegistryRouteParamSpec = {
  schema: AlpineApkFilenameSchema,
  code: "NAME_INVALID",
  message: "invalid .apk filename",
};

/**
 * Alpine (apk) repository. Publishing a `.apk` into `<arch>` parses its
 * `.PKGINFO` and hosts the blob; `GET /<arch>/APKINDEX.tar.gz` returns a freshly
 * regenerated index over the live versions for that arch, and
 * `GET /<arch>/<name>-<version>.apk` serves the stored package blob. The format
 * is virtualizable; like registry-apt/registry-maven it does not implement a
 * proxy ingest, so it does not advertise the proxyable capability.
 */
class AlpineAdapterState {
  /** `GET /<arch>/APKINDEX.tar.gz` — regenerate the index over the arch's live versions. */
  async index(arch: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const entries = await this.indexEntries(ctx, arch);
    const tarGz = buildApkIndexTarGz(entries);
    return bytesResponseWithEtag(req, tarGz, { "content-type": "application/gzip" });
  }

  /** `GET /<arch>/<name>-<version>.apk` — serve the stored package blob. */
  async download(
    arch: string,
    filename: string,
    _req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const meta = await this.findByFilename(ctx, arch, filename);
    if (!meta) return new Response("Not Found", { status: 404 });
    return serveRegistryBlob(ctx, {
      digest: meta.blobDigest,
      kind: ALPINE_APK_KIND,
      scope: alpineBlobScope(arch, filename),
      contentType: "application/vnd.alpine.apk",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  async publish(
    arch: string,
    req: Request,
    ctx: RegistryRequestContext,
    filename?: string,
  ): Promise<Response> {
    // `PUT /:arch/:filename` carries a path segment; its route params schema
    // rejects anything that is not a `.apk` filename before the body is parsed.
    // The canonical name is derived from `.PKGINFO`, but authorization on that
    // route is scoped to the URL segment, so we forward it to the handler which
    // rejects a mismatch (confused-deputy guard).
    const result = await handleAlpinePublish(arch, req, ctx, filename);
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

const alpineDefinition = registryAdapter("alpine")
  .stateClass(AlpineAdapterState)
  .module((module) =>
    module
      .displayName("Alpine")
      .mount("alpine")
      // Virtualizable only: no proxyIngest/upstream mirror is implemented.
      .capabilities("virtualizable")
      .errorResponseKind("singleError"),
  )
  .scan({
    defaultOsvEcosystem: "Alpine",
    referencedDigests: (metadata) =>
      typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
  })
  .basicAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "filename",
        artifactRef: (filename, { params }) =>
          params.arch ? alpineBlobScope(params.arch, filename) : null,
      }),
    ]),
  )
  .routes((route) => [
    // `APKINDEX.tar.gz` is a literal second segment declared before `/:arch/:filename`.
    route
      .get(`/:arch/${APKINDEX_NAME}`, "index")
      .params({ arch: archParam })
      .calls((state, { params, req, ctx }) => state.index(params.arch, req, ctx)),
    route
      .get("/:arch/:filename", "download")
      .params({ arch: archParam, filename: apkFilenameParam })
      .calls((state, { params, req, ctx }) =>
        state.download(params.arch, params.filename, req, ctx),
      ),
    route
      .put("/:arch/:filename", "publishNamed")
      .params({ arch: archParam, filename: apkFilenameParam })
      .calls((state, { params, req, ctx }) =>
        state.publish(params.arch, req, ctx, params.filename),
      ),
    route
      .put("/:arch", "publish")
      .params({ arch: archParam })
      .calls((state, { params, req, ctx }) => state.publish(params.arch, req, ctx)),
  ]);

export class AlpineAdapter extends alpineDefinition.adapterClass() {}
export const alpineRegistryPlugin = createRegistryAdapterPlugin(AlpineAdapter);
