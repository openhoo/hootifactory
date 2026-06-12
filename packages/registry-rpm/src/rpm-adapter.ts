import {
  bytesResponseWithEtag,
  createRegistryAdapterPlugin,
  Errors,
  type RegistryPackageHandle,
  type RegistryRequestContext,
  type RegistryRouteParamSpec,
  registryAdapter,
  repoResponseCache,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { handleRpmPublish, RPM_BLOB_KIND, rpmBlobScope } from "./rpm-publish-lifecycle";
import {
  type BuiltPrimary,
  buildPrimary,
  buildRepomd,
  type RpmPrimaryPackage,
} from "./rpm-repodata";
import { parseRpmVersionMeta, RpmFileSchema } from "./rpm-validation";

const REPODATA_XML = "application/xml";
const REPODATA_TTL_MS = 5_000;

/**
 * YUM/DNF repository. Serves a deterministic `repodata/` (repomd.xml +
 * primary.xml.gz) computed from stored package versions, serves the `.rpm`
 * blobs, and accepts publish via PUT/POST of an `.rpm` (identity from its header
 * with a filename fallback). One plugin backs the `rpm`, `yum`, and `dnf` ids.
 */
class RpmAdapterState {
  /** Single cache key used by both repomd + primary so checksums always match. */
  private readonly primaryCache = repoResponseCache<BuiltPrimary>({ ttlMs: REPODATA_TTL_MS });

  /** Collect every live RPM version across all packages as primary entries. */
  async collectPackages(ctx: RegistryRequestContext): Promise<RpmPrimaryPackage[]> {
    const pkgs: RegistryPackageHandle[] = await ctx.data.packages.list();
    if (pkgs.length === 0) return [];
    const byPackage = await ctx.data.versions.listLiveForPackages(pkgs, {
      orderByCreated: "asc",
    });
    const out: RpmPrimaryPackage[] = [];
    for (const rows of byPackage.values()) {
      for (const row of rows) {
        const meta = parseRpmVersionMeta(row.metadata);
        if (!meta) continue;
        out.push({
          meta,
          href: `packages/${meta.file}`,
          buildTime: meta.buildTime ?? Math.floor(row.createdAt.getTime() / 1000),
        });
      }
    }
    return out;
  }

  /** Build the deterministic primary metadata for the current repo state. */
  async buildRepoPrimary(ctx: RegistryRequestContext): Promise<BuiltPrimary> {
    const entry = await this.primaryCache.get(ctx, "primary", async () => {
      const primary = buildPrimary(await this.collectPackages(ctx));
      return { body: primary, etag: `"${primary.sha256Gz}"` };
    });
    return entry.body;
  }

  async repomd(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const primary = await this.buildRepoPrimary(ctx);
    return textResponseWithEtag(req, buildRepomd(primary), { "content-type": REPODATA_XML });
  }

  async primary(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const primary = await this.buildRepoPrimary(ctx);
    const etag = `"${primary.sha256Gz}"`;
    return bytesResponseWithEtag(req, primary.gz, { "content-type": "application/gzip" }, etag);
  }

  async download(file: string, _req: Request, ctx: RegistryRequestContext): Promise<Response> {
    file = parseRpmFile(file);
    const asset = await ctx.data.assets.findByScope({ role: "rpm_package", scope: file });
    if (!asset) throw Errors.notFound();
    return serveRegistryBlob(ctx, {
      digest: asset.digest,
      kind: RPM_BLOB_KIND,
      scope: rpmBlobScope(file),
      contentType: "application/x-rpm",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  async publish(
    file: string | undefined,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const res = await handleRpmPublish(file, req, ctx);
    if (res.status >= 200 && res.status < 300) this.primaryCache.clear(ctx);
    return res;
  }
}

function parseRpmFile(file: string): string {
  const parsed = RpmFileSchema.safeParse(file);
  if (!parsed.success) throw Errors.notFound();
  return parsed.data;
}

/**
 * Publish-route `:file` param. Download keeps its in-handler `parseRpmFile`
 * instead: a non-`.rpm` download path is a 404 miss, not a 400 malformed
 * request.
 */
const fileParam: RegistryRouteParamSpec = {
  schema: RpmFileSchema,
  code: "NAME_INVALID",
  message: "invalid RPM filename",
};

const rpmDefinition = registryAdapter("rpm")
  .stateClass(RpmAdapterState)
  .module((module) =>
    module
      .displayName("RPM")
      .mount("rpm")
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("repomd"),
  )
  .scan((scan) =>
    scan
      .osvEcosystem("Red Hat")
      .referencedDigests((metadata) =>
        typeof metadata.rpmDigest === "string" ? [metadata.rpmDigest] : [],
      ),
  )
  .basicAuth()
  .permissions((p) => p.byParams([p.artifactRule({ param: "file" })]))
  .routes((route) => [
    route
      .get("/repodata/repomd.xml", "repomd")
      .calls((state, { req, ctx }) => state.repomd(req, ctx)),
    route
      .get("/repodata/primary.xml.gz", "primary")
      .calls((state, { req, ctx }) => state.primary(req, ctx)),
    route
      .get("/packages/:file", "download")
      .calls((state, { params, req, ctx }) => state.download(params.file, req, ctx)),
    route
      .put("/packages/:file", "publish")
      .params({ file: fileParam })
      .calls((state, { params, req, ctx }) => state.publish(params.file, req, ctx)),
    route
      .post("/packages/:file", "publish")
      .params({ file: fileParam })
      .calls((state, { params, req, ctx }) => state.publish(params.file, req, ctx)),
    route
      .post("/", "publishRoot")
      .calls((state, { req, ctx }) => state.publish(undefined, req, ctx)),
  ]);

export class RpmAdapter extends rpmDefinition.adapterClass() {}
export const rpmRegistryPlugin = createRegistryAdapterPlugin(RpmAdapter);
