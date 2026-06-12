import {
  asJsonRecord,
  createRegistryAdapterPlugin,
  Errors,
  parseRegistryInput,
  type RegistryRequestContext,
  registryAdapter,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import {
  buildPackageMetadata,
  buildPackagesRoot,
  type ComposerVersionEntry,
  readComposerVersionMeta,
} from "./composer-metadata";
import { COMPOSER_DIST_KIND, handleComposerUpload } from "./composer-publish-lifecycle";
import {
  ComposerDistPathSchema,
  ComposerPackageSchema,
  ComposerVendorSchema,
  stripMetadataSuffix,
} from "./composer-validation";

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** Composer/Packagist: `packages.json` + v2 `/p2` metadata + zip dist + a custom upload. */
class ComposerAdapterState {
  base(ctx: RegistryRequestContext): string {
    return `${ctx.baseUrl}/${ctx.repo.mountPath}`;
  }

  async root(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const names = (await ctx.data.packages.listNames())
      .map((row) => row.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return textResponseWithEtag(req, buildPackagesRoot(this.base(ctx), names), JSON_HEADERS);
  }

  async metadata(
    vendor: string,
    packageParam: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const { pkg, dev } = stripMetadataSuffix(packageParam);
    const vendorName = parseRegistryInput(ComposerVendorSchema, vendor.toLowerCase(), {
      code: "NAME_INVALID",
      message: "invalid composer vendor",
    });
    const pkgName = parseRegistryInput(ComposerPackageSchema, pkg.toLowerCase(), {
      code: "NAME_INVALID",
      message: "invalid composer package",
    });
    const name = `${vendorName}/${pkgName}`;
    const row = await ctx.data.packages.findByName(name);
    if (!row) {
      return new Response(JSON.stringify({ packages: { [name]: [] } }), {
        status: 404,
        headers: JSON_HEADERS,
      });
    }
    const versions = await ctx.data.versions.listLive(row, { orderByCreated: "desc" });
    const entries: ComposerVersionEntry[] = versions.flatMap((version) => {
      const meta = readComposerVersionMeta(version.metadata);
      if (!meta) return [];
      // Composer fetches stable tags and `~dev` branches as separate documents.
      if (dev !== meta.version.startsWith("dev-")) return [];
      return [{ meta, time: version.createdAt.toISOString() }];
    });
    return textResponseWithEtag(
      req,
      buildPackageMetadata(this.base(ctx), name, entries),
      JSON_HEADERS,
    );
  }

  async download(path: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const distPath = parseRegistryInput(ComposerDistPathSchema, path, {
      code: "NAME_INVALID",
      message: "invalid composer dist path",
    });
    const asset = await ctx.data.assets.findByScope({ role: COMPOSER_DIST_KIND, scope: distPath });
    if (!asset) throw Errors.notFound();
    return serveRegistryBlob(ctx, {
      digest: asset.digest,
      kind: COMPOSER_DIST_KIND,
      scope: distPath,
      contentType: "application/zip",
      redirect: req.method === "GET",
      blocked: () => new Response("dist blocked by scan policy", { status: 403 }),
    });
  }

  async upload(
    vendor: string,
    pkg: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const vendorName = parseRegistryInput(ComposerVendorSchema, vendor.toLowerCase(), {
      code: "NAME_INVALID",
      message: "invalid composer vendor",
    });
    const pkgName = parseRegistryInput(ComposerPackageSchema, pkg.toLowerCase(), {
      code: "NAME_INVALID",
      message: "invalid composer package",
    });
    return handleComposerUpload(req, ctx, `${vendorName}/${pkgName}`);
  }
}

function composerDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const require = asJsonRecord(metadata.require);
  if (!require) return {};
  const out: Record<string, string> = {};
  for (const [name, constraint] of Object.entries(require)) {
    if (typeof constraint === "string") out[name] = constraint;
  }
  return out;
}

const composerDefinition = registryAdapter("composer")
  .stateClass(ComposerAdapterState)
  .module((module) =>
    module
      .displayName("Composer")
      .mount("composer")
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("root", "metadata")
      .compressibleContentTypes("application/json"),
  )
  .scan((scan) =>
    scan
      .osvEcosystem("Packagist")
      .purlType("composer")
      .dependencies(composerDependencyGraph)
      .referencedDigestPaths("distDigest"),
  )
  .basicAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({ param: "path" }),
      p.packageRule({
        param: "package",
        normalize: (pkgParam, { params }) => {
          if (!params.vendor) return null;
          const { pkg } = stripMetadataSuffix(pkgParam);
          return `${params.vendor}/${pkg}`.toLowerCase();
        },
      }),
    ]),
  )
  .routes((route) => [
    route.get("/packages.json", "root").calls((state, { req, ctx }) => state.root(req, ctx)),
    route
      .get("/p2/:vendor/:package", "metadata")
      .calls((state, { params, req, ctx }) =>
        state.metadata(params.vendor, params.package, req, ctx),
      ),
    route
      .get("/dist/:path+", "download")
      .calls((state, { params, req, ctx }) => state.download(params.path, req, ctx)),
    route
      .put("/packages/:vendor/:package", "upload")
      .calls((state, { params, req, ctx }) =>
        state.upload(params.vendor, params.package, req, ctx),
      ),
  ]);

export class ComposerAdapter extends composerDefinition.adapterClass() {}
export const composerRegistryPlugin = createRegistryAdapterPlugin(ComposerAdapter);
