import {
  basicAuthChallenge,
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPackageHandle,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { buildHomebrewFormulaJson, type HomebrewFormulaJson } from "./homebrew-formula";
import { handleHomebrewPublish } from "./homebrew-upload-lifecycle";
import {
  BOTTLE_ASSET_ROLE,
  BOTTLE_MEDIA_TYPE,
  HomebrewNameSchema,
  isValidBottleFileName,
  parseHomebrewVersionMeta,
} from "./homebrew-validation";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

function parseFormulaName(name: string): string {
  return parseRegistryInput(HomebrewNameSchema, name, {
    code: "NAME_INVALID",
    message: "invalid formula name",
  });
}

/** A formula name carries `.json` in the path; the handler strips that suffix. */
function stripJsonSuffix(value: string): string | null {
  return value.endsWith(".json") ? value.slice(0, -".json".length) : null;
}

/**
 * Homebrew JSON API (consumed when HOMEBREW_API_DOMAIN + HOMEBREW_BOTTLE_DOMAIN
 * point at a repo mount). Serves the formula index/objects plus bottle blobs and
 * a hootifactory PUT extension for publishing bottles.
 */
export class HomebrewAdapter implements RegistryPlugin {
  readonly id = "homebrew" as const;
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Homebrew",
      mountSegment: "homebrew",
      errorResponseKind: "singleError",
      compressibleHandlers: ["formulaIndex", "formula", "formulaNames"],
      compressibleContentTypes: [JSON_CONTENT_TYPE],
      scan: {
        defaultOsvEcosystem: "Homebrew",
        dependencyGraph: ({ metadata }) => ({
          deps: homebrewDependencyGraph(metadata),
          osvEcosystem: "Homebrew",
          purlType: "brew",
        }),
        referencedDigests: (metadata) => homebrewReferencedDigests(metadata),
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      route.get("/api/formula.json", "formulaIndex", ({ req, ctx }) => this.formulaIndex(req, ctx)),
      route.get("/api/formula_names.txt", "formulaNames", ({ req, ctx }) =>
        this.formulaNames(req, ctx),
      ),
      route.get("/api/formula/:name", "formula", ({ params, req, ctx }) =>
        this.formula(params.name, req, ctx),
      ),
      route.put("/api/formula/:name/:version/:tag", "publish", ({ params, req, ctx }) =>
        handleHomebrewPublish(params.name, params.version, params.tag, req, ctx),
      ),
      route.get("/bottles/:file", "download", ({ params, req, ctx }) =>
        this.download(params.file, req, ctx),
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
    const file = match?.params.file;
    if (file) {
      // A bottle filename's `<name>-<ver>.<tag>` stem is ambiguous to split (both
      // name and version admit `-`/`.`), so we identify the artifact by its full
      // filename ref and leave `packageName` unset rather than guess a wrong one.
      if (isValidBottleFileName(file)) {
        return { ...permission, resource: { type: "artifact", artifactRef: file } };
      }
      return permission;
    }
    const nameOrVersion = match?.params.name;
    if (nameOrVersion) {
      // The formula read route carries `:name.json`; the publish route's `:name`
      // is the bare formula name. Strip the suffix only when present.
      const name = stripJsonSuffix(nameOrVersion) ?? nameOrVersion;
      return { ...permission, resource: { type: "package", packageName: name } };
    }
    return permission;
  }

  handle = this.delegate.handle;

  private base(ctx: RegistryRequestContext): string {
    return `${ctx.baseUrl}/${ctx.repo.mountPath}`;
  }

  /** Resolve a package's stable formula object from its newest live bottled version. */
  private async resolveFormula(
    ctx: RegistryRequestContext,
    pkg: RegistryPackageHandle,
    name: string,
  ): Promise<HomebrewFormulaJson | null> {
    const versions = await ctx.data.versions.listLive(pkg, { orderByCreated: "desc" });
    for (const row of versions) {
      const metadata = parseHomebrewVersionMeta(row.metadata);
      if (metadata && Object.keys(metadata.bottles).length > 0) {
        return buildHomebrewFormulaJson({
          name,
          version: row.version,
          metadata,
          base: this.base(ctx),
          tap: ctx.repo.mountPath,
        });
      }
    }
    return null;
  }

  private async formulaIndex(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const summaries = await ctx.data.packages.list();
    const formulas: HomebrewFormulaJson[] = [];
    for (const summary of summaries) {
      const formula = await this.resolveFormula(ctx, summary, summary.name);
      if (formula) formulas.push(formula);
    }
    // Deterministic name ordering keeps the index document stable for ETags.
    formulas.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return textResponseWithEtag(req, JSON.stringify(formulas), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  private async formulaNames(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const rows = await ctx.data.packages.listNames();
    const names = rows.map((row) => row.name).sort();
    const body = names.length > 0 ? `${names.join("\n")}\n` : "";
    return textResponseWithEtag(req, body, { "content-type": TEXT_CONTENT_TYPE });
  }

  private async formula(
    nameParam: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const stripped = stripJsonSuffix(nameParam);
    if (stripped === null) throw Errors.notFound();
    const name = parseFormulaName(stripped);
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) throw Errors.notFound();
    const formula = await this.resolveFormula(ctx, pkg, name);
    if (!formula) throw Errors.notFound();
    return textResponseWithEtag(req, JSON.stringify(formula), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  private async download(
    file: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    // The bottle filename IS the stored asset/blob-ref scope, so resolve the blob
    // directly by it. We never split name/version out of the filename — that stem
    // is ambiguous (both admit `-`/`.`), and real brew downloads by URL, never by
    // re-parsing the path.
    if (!isValidBottleFileName(file)) throw Errors.notFound();
    const asset = await ctx.data.assets.findByScope({ role: BOTTLE_ASSET_ROLE, scope: file });
    if (!asset) throw Errors.notFound();
    return serveRegistryBlob(ctx, {
      digest: asset.digest,
      kind: BOTTLE_ASSET_ROLE,
      scope: file,
      contentType: BOTTLE_MEDIA_TYPE,
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }
}

function homebrewDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const parsed = parseHomebrewVersionMeta(metadata);
  if (!parsed?.dependencies) return {};
  return Object.fromEntries(parsed.dependencies.map((dep) => [dep, "*"]));
}

function homebrewReferencedDigests(metadata: Record<string, unknown>): string[] {
  const parsed = parseHomebrewVersionMeta(metadata);
  if (!parsed) return [];
  return Object.values(parsed.bottles).map((bottle) => bottle.blobDigest);
}

export const homebrewRegistryPlugin: RegistryPlugin = new HomebrewAdapter();
