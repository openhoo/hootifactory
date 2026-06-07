import {
  Errors,
  type HttpMethod,
  ifNoneMatch,
  type Permission,
  type RegistryPackageHandle,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryAdapter,
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

/**
 * YUM/DNF repository. Serves a deterministic `repodata/` (repomd.xml +
 * primary.xml.gz) computed from stored package versions, serves the `.rpm`
 * blobs, and accepts publish via PUT/POST of an `.rpm` (identity from its header
 * with a filename fallback). One plugin backs the `rpm`, `yum`, and `dnf` ids.
 */
class RpmAdapterState {
  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    const permission = readWritePermission(method);
    const file = match?.params.file;
    if (file) {
      return { ...permission, resource: { type: "artifact", artifactRef: file } };
    }
    return permission;
  }

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
    return buildPrimary(await this.collectPackages(ctx));
  }

  async repomd(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const primary = await this.buildRepoPrimary(ctx);
    return textResponseWithEtag(req, buildRepomd(primary), { "content-type": REPODATA_XML });
  }

  async primary(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const primary = await this.buildRepoPrimary(ctx);
    const etag = `"${primary.sha256Gz}"`;
    // The gz bytes are a pure function of the repo state, so the sha256-derived
    // etag lets clients skip re-downloading unchanged metadata on refresh.
    if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers: { etag } });
    return new Response(primary.gz, {
      headers: {
        "content-type": "application/gzip",
        etag,
      },
    });
  }

  async download(file: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    file = parseRpmFile(file);
    const asset = await ctx.data.assets.findByScope({ role: "rpm_package", scope: file });
    if (!asset) throw Errors.notFound();
    return serveRegistryBlob(ctx, {
      digest: asset.digest,
      kind: RPM_BLOB_KIND,
      scope: rpmBlobScope(file),
      contentType: "application/x-rpm",
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  async publish(
    file: string | undefined,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return handleRpmPublish(file, req, ctx);
  }
}

function parseRpmFile(file: string): string {
  const parsed = RpmFileSchema.safeParse(file);
  if (!parsed.success) throw Errors.notFound();
  return parsed.data;
}

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
  .fromState((state) => state.defaultPermission("requiredPermission"))
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
      .calls((state, { params, req, ctx }) => state.publish(params.file, req, ctx)),
    route
      .post("/packages/:file", "publish")
      .calls((state, { params, req, ctx }) => state.publish(params.file, req, ctx)),
    route
      .post("/", "publishRoot")
      .calls((state, { req, ctx }) => state.publish(undefined, req, ctx)),
  ]);

export class RpmAdapter extends rpmDefinition.adapterClass() {}
export const rpmRegistryPlugin: RegistryPlugin = new RpmAdapter();
