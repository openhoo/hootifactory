import {
  asJsonRecord,
  bytesResponseWithEtag,
  createRegistryAdapterPlugin,
  Errors,
  parseRegistryInput,
  type RegistryAssetRow,
  type RegistryRequestContext,
  registryAdapter,
  repoResponseCache,
  serveAssetBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { type AptDebEntry, type AptSnapshot, buildAptSnapshot } from "./apt-index";
import { APT_DEB_KIND, handleAptUpload } from "./apt-upload-lifecycle";
import {
  archFromDir,
  ComponentSchema,
  isValidComponent,
  isValidSuite,
  PoolPathSchema,
  SuiteSchema,
} from "./apt-validation";

const TEXT_PLAIN = { "content-type": "text/plain; charset=utf-8" } as const;
const SNAPSHOT_TTL_MS = 5_000;

/** APT (Debian): pool upload/download + generated Release/Packages indexes. */
class AptAdapterState {
  readonly snapshotCache = repoResponseCache<AptSnapshot>({ ttlMs: SNAPSHOT_TTL_MS });

  async listDebAssets(ctx: RegistryRequestContext): Promise<RegistryAssetRow[]> {
    const all: RegistryAssetRow[] = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const { assets, total } = await ctx.data.assets.list({ limit: pageSize, offset });
      all.push(...assets);
      if (all.length >= total || assets.length === 0) break;
    }
    return all.filter((asset) => asset.role === APT_DEB_KIND);
  }

  async snapshot(ctx: RegistryRequestContext, suite: string): Promise<AptSnapshot> {
    const entry = await this.snapshotCache.get(ctx, suite, async () => {
      const assets = await this.listDebAssets(ctx);
      const entries: AptDebEntry[] = [];
      let latestMs = 0;
      for (const asset of assets) {
        const meta = asJsonRecord(asset.metadata);
        if (!meta || meta.suite !== suite) continue;
        const entry = toDebEntry(asset, meta);
        if (entry) {
          entries.push(entry);
          latestMs = Math.max(latestMs, asset.createdAt.getTime());
        }
      }
      const date = formatDebDate(latestMs > 0 ? new Date(latestMs) : new Date(0));
      return { body: buildAptSnapshot(suite, date, entries), etag: "" };
    });
    return entry.body;
  }

  clearSnapshot(ctx: RegistryRequestContext, suite: string): void {
    this.snapshotCache.clear(ctx, suite);
  }

  async release(suite: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const validSuite = parseRegistryInput(SuiteSchema, suite, {
      code: "NAME_INVALID",
      message: "invalid suite",
    });
    const snapshot = await this.snapshot(ctx, validSuite);
    return textResponseWithEtag(req, snapshot.release, TEXT_PLAIN);
  }

  async packages(
    suite: string,
    component: string,
    archdir: string,
    gz: boolean,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const validSuite = parseRegistryInput(SuiteSchema, suite, {
      code: "NAME_INVALID",
      message: "invalid suite",
    });
    const validComponent = parseRegistryInput(ComponentSchema, component, {
      code: "NAME_INVALID",
      message: "invalid component",
    });
    const arch = archFromDir(archdir);
    if (!arch) throw Errors.notFound();
    const snapshot = await this.snapshot(ctx, validSuite);
    const entry = snapshot.packages.get(`${validComponent}/binary-${arch}`);
    if (!entry) throw Errors.notFound();
    if (!gz) return textResponseWithEtag(req, entry.text, TEXT_PLAIN);
    return bytesResponseWithEtag(req, entry.gz, { "content-type": "application/gzip" });
  }

  async download(path: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const poolPath = parseRegistryInput(PoolPathSchema, `pool/${path}`, {
      code: "NAME_INVALID",
      message: "invalid pool path",
    });
    return serveAssetBlob(ctx, {
      role: APT_DEB_KIND,
      kind: APT_DEB_KIND,
      scope: poolPath,
      contentType: "application/vnd.debian.binary-package",
      redirect: req.method === "GET",
    });
  }

  async upload(path: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const poolPath = parseRegistryInput(PoolPathSchema, `pool/${path}`, {
      code: "NAME_INVALID",
      message: "invalid pool path",
    });
    const url = new URL(req.url);
    const suite = url.searchParams.get("suite") ?? "stable";
    const component = url.searchParams.get("component") ?? "main";
    if (!isValidSuite(suite) || !isValidComponent(component)) {
      return new Response("invalid suite or component", { status: 400 });
    }
    const res = await handleAptUpload({ poolPath, suite, component, req, ctx });
    if (res.status >= 200 && res.status < 300) this.clearSnapshot(ctx, suite);
    return res;
  }
}

function formatDebDate(date: Date): string {
  return date.toUTCString().replace("GMT", "UTC");
}

function toDebEntry(asset: RegistryAssetRow, meta: Record<string, unknown>): AptDebEntry | null {
  const str = (key: string): string | null =>
    typeof meta[key] === "string" ? (meta[key] as string) : null;
  const controlText = str("controlText");
  const md5 = str("md5");
  const sha256 = str("sha256");
  const pkg = str("package");
  const version = str("version");
  const architecture = str("architecture");
  const component = str("component");
  const size = typeof meta.debSize === "number" ? meta.debSize : null;
  if (
    !controlText ||
    !md5 ||
    !sha256 ||
    !pkg ||
    !version ||
    !architecture ||
    !component ||
    size === null
  ) {
    return null;
  }
  return {
    controlText,
    filename: asset.scope,
    size,
    md5,
    sha256,
    package: pkg,
    version,
    architecture,
    component,
  };
}

function aptDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const deps = metadata.deps;
  if (!Array.isArray(deps)) return {};
  const out: Record<string, string> = {};
  for (const name of deps) {
    if (typeof name === "string") out[name] = "";
  }
  return out;
}

function readOsvEcosystem(metadata: Record<string, unknown>): string {
  return typeof metadata.osvEcosystem === "string" ? metadata.osvEcosystem : "Debian:12";
}

const aptDefinition = registryAdapter("apt")
  .stateClass(AptAdapterState)
  .module((module) =>
    module
      .displayName("APT")
      .mount("apt")
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers(),
  )
  .scan((scan) =>
    scan
      .osvEcosystem("Debian:12")
      .dependencyGraph(({ metadata }) => ({
        deps: aptDependencyGraph(metadata),
        osvEcosystem: readOsvEcosystem(metadata),
        purlType: "deb",
      }))
      .referencedDigestPaths("debDigest"),
  )
  .basicAuth()
  .permissions((p) =>
    p.byParams([p.artifactRule({ param: "path", artifactRef: (path) => `pool/${path}` })]),
  )
  .routes((route) => [
    route
      .get("/dists/:suite/Release", "release")
      .calls((state, { params, req, ctx }) => state.release(params.suite, req, ctx)),
    route.get("/dists/:suite/InRelease", "inRelease", () => {
      throw Errors.notFound();
    }),
    route.get("/dists/:suite/Release.gpg", "releaseSig", () => {
      throw Errors.notFound();
    }),
    route
      .get("/dists/:suite/:component/:archdir/Packages", "packages")
      .calls((state, { params, req, ctx }) =>
        state.packages(params.suite, params.component, params.archdir, false, req, ctx),
      ),
    route
      .get("/dists/:suite/:component/:archdir/Packages.gz", "packagesGz")
      .calls((state, { params, req, ctx }) =>
        state.packages(params.suite, params.component, params.archdir, true, req, ctx),
      ),
    route
      .get("/pool/:path+", "download")
      .calls((state, { params, req, ctx }) => state.download(params.path, req, ctx)),
    route
      .put("/pool/:path+", "upload")
      .calls((state, { params, req, ctx }) => state.upload(params.path, req, ctx)),
  ]);

export class AptAdapter extends aptDefinition.adapterClass() {}
export const aptRegistryPlugin = createRegistryAdapterPlugin(AptAdapter);
