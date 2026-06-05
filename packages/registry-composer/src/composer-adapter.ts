import {
  asJsonRecord,
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
export class ComposerAdapter implements RegistryPlugin {
  readonly id = "composer" as const;
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Composer",
      mountSegment: "composer",
      errorResponseKind: "singleError",
      compressibleHandlers: ["root", "metadata"],
      compressibleContentTypes: ["application/json"],
      scan: {
        defaultOsvEcosystem: "Packagist",
        dependencyGraph: ({ metadata }) => ({
          deps: composerDependencyGraph(metadata),
          osvEcosystem: "Packagist",
          purlType: "composer",
        }),
        referencedDigests: (metadata) =>
          typeof metadata.distDigest === "string" ? [metadata.distDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      route.get("/packages.json", "root", ({ req, ctx }) => this.root(req, ctx)),
      route.get("/p2/:vendor/:package", "metadata", ({ params, req, ctx }) =>
        this.metadata(params.vendor, params.package, req, ctx),
      ),
      route.get("/dist/:path+", "download", ({ params, req, ctx }) =>
        this.download(params.path, req, ctx),
      ),
      route.put("/packages/:vendor/:package", "upload", ({ params, req, ctx }) =>
        this.upload(params.vendor, params.package, req, ctx),
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
    const path = match?.params.path;
    if (path) {
      return { ...permission, resource: { type: "artifact", artifactRef: path } };
    }
    const vendor = match?.params.vendor;
    const pkgParam = match?.params.package;
    if (vendor && pkgParam) {
      const { pkg } = stripMetadataSuffix(pkgParam);
      return {
        ...permission,
        resource: { type: "package", packageName: `${vendor}/${pkg}`.toLowerCase() },
      };
    }
    return permission;
  }

  handle = this.delegate.handle;

  private base(ctx: RegistryRequestContext): string {
    return `${ctx.baseUrl}/${ctx.repo.mountPath}`;
  }

  private async root(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const names = (await ctx.data.packages.listNames())
      .map((row) => row.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return textResponseWithEtag(req, buildPackagesRoot(this.base(ctx), names), JSON_HEADERS);
  }

  private async metadata(
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

  private async download(
    path: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
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

  private async upload(
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

export const composerRegistryPlugin: RegistryPlugin = new ComposerAdapter();
