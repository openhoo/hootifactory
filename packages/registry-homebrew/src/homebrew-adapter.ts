import {
  createRegistryAdapterPlugin,
  Errors,
  parseRegistryInput,
  type RegistryPackageHandle,
  type RegistryRequestContext,
  registryAdapter,
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
class HomebrewAdapterState {
  base(ctx: RegistryRequestContext): string {
    return `${ctx.baseUrl}/${ctx.repo.mountPath}`;
  }

  /** Resolve a package's stable formula object from its newest live bottled version. */
  async resolveFormula(
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

  async formulaIndex(req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

  async formulaNames(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const rows = await ctx.data.packages.listNames();
    const names = rows.map((row) => row.name).sort();
    const body = names.length > 0 ? `${names.join("\n")}\n` : "";
    return textResponseWithEtag(req, body, { "content-type": TEXT_CONTENT_TYPE });
  }

  async formula(nameParam: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

  async download(file: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

const homebrewDefinition = registryAdapter("homebrew")
  .stateClass(HomebrewAdapterState)
  .module((module) =>
    module
      .displayName("Homebrew")
      .mount("homebrew")
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("formulaIndex", "formula", "formulaNames")
      .compressibleContentTypes(JSON_CONTENT_TYPE),
  )
  .scan((scan) =>
    scan
      .osvEcosystem("Homebrew")
      .purlType("brew")
      .dependencies(homebrewDependencyGraph)
      .referencedDigests((metadata) => homebrewReferencedDigests(metadata)),
  )
  .basicAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "file",
        normalize: (file) => (isValidBottleFileName(file) ? file : null),
      }),
      p.packageRule({ param: "name", normalize: (name) => stripJsonSuffix(name) ?? name }),
    ]),
  )
  .routes((route) => [
    route
      .get("/api/formula.json", "formulaIndex")
      .calls((state, { req, ctx }) => state.formulaIndex(req, ctx)),
    route
      .get("/api/formula_names.txt", "formulaNames")
      .calls((state, { req, ctx }) => state.formulaNames(req, ctx)),
    route
      .get("/api/formula/:name", "formula")
      .calls((state, { params, req, ctx }) => state.formula(params.name, req, ctx)),
    route.put("/api/formula/:name/:version/:tag", "publish", ({ params, req, ctx }) =>
      handleHomebrewPublish(params.name, params.version, params.tag, req, ctx),
    ),
    route
      .get("/bottles/:file", "download")
      .calls((state, { params, req, ctx }) => state.download(params.file, req, ctx)),
  ]);

export class HomebrewAdapter extends homebrewDefinition.adapterClass() {}
export const homebrewRegistryPlugin = createRegistryAdapterPlugin(HomebrewAdapter);
