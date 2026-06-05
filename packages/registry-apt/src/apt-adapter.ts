import {
  asJsonRecord,
  basicAuthChallenge,
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  ifNoneMatch,
  type Permission,
  parseRegistryInput,
  type RegistryAssetRow,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
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

interface SnapshotCacheEntry {
  snapshot: AptSnapshot;
  expiresAt: number;
}

/** APT (Debian): pool upload/download + generated Release/Packages indexes. */
export class AptAdapter implements RegistryPlugin {
  readonly id = "apt" as const;
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;
  private readonly snapshotCache = new Map<string, SnapshotCacheEntry>();

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "APT",
      mountSegment: "apt",
      errorResponseKind: "singleError",
      compressibleHandlers: [],
      scan: {
        defaultOsvEcosystem: "Debian:12",
        dependencyGraph: ({ metadata }) => ({
          deps: aptDependencyGraph(metadata),
          osvEcosystem: readOsvEcosystem(metadata),
          purlType: "deb",
        }),
        referencedDigests: (metadata) =>
          typeof metadata.debDigest === "string" ? [metadata.debDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      route.get("/dists/:suite/Release", "release", ({ params, req, ctx }) =>
        this.release(params.suite, req, ctx),
      ),
      route.get("/dists/:suite/InRelease", "inRelease", () => notFound()),
      route.get("/dists/:suite/Release.gpg", "releaseSig", () => notFound()),
      route.get("/dists/:suite/:component/:archdir/Packages", "packages", ({ params, req, ctx }) =>
        this.packages(params.suite, params.component, params.archdir, false, req, ctx),
      ),
      route.get(
        "/dists/:suite/:component/:archdir/Packages.gz",
        "packagesGz",
        ({ params, req, ctx }) =>
          this.packages(params.suite, params.component, params.archdir, true, req, ctx),
      ),
      route.get("/pool/:path+", "download", ({ params, req, ctx }) =>
        this.download(params.path, req, ctx),
      ),
      route.put("/pool/:path+", "upload", ({ params, req, ctx }) =>
        this.upload(params.path, req, ctx),
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
      return { ...permission, resource: { type: "artifact", artifactRef: `pool/${path}` } };
    }
    return permission;
  }

  handle = this.delegate.handle;

  private async listDebAssets(ctx: RegistryRequestContext): Promise<RegistryAssetRow[]> {
    const all: RegistryAssetRow[] = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const { assets, total } = await ctx.data.assets.list({ limit: pageSize, offset });
      all.push(...assets);
      if (all.length >= total || assets.length === 0) break;
    }
    return all.filter((asset) => asset.role === APT_DEB_KIND);
  }

  private async snapshot(ctx: RegistryRequestContext, suite: string): Promise<AptSnapshot> {
    const key = `${ctx.repo.id}:${suite}`;
    const cached = this.snapshotCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.snapshot;

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
    const snapshot = buildAptSnapshot(suite, date, entries);
    this.snapshotCache.set(key, { snapshot, expiresAt: Date.now() + SNAPSHOT_TTL_MS });
    return snapshot;
  }

  private clearSnapshot(ctx: RegistryRequestContext, suite: string): void {
    this.snapshotCache.delete(`${ctx.repo.id}:${suite}`);
  }

  private async release(
    suite: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const validSuite = parseRegistryInput(SuiteSchema, suite, {
      code: "NAME_INVALID",
      message: "invalid suite",
    });
    const snapshot = await this.snapshot(ctx, validSuite);
    return textResponseWithEtag(req, snapshot.release, TEXT_PLAIN);
  }

  private async packages(
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
    const etag = `"${new Bun.CryptoHasher("md5").update(entry.gz).digest("hex")}"`;
    if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers: { etag } });
    return new Response(entry.gz, { headers: { "content-type": "application/gzip", etag } });
  }

  private async download(
    path: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const poolPath = parseRegistryInput(PoolPathSchema, `pool/${path}`, {
      code: "NAME_INVALID",
      message: "invalid pool path",
    });
    const asset = await ctx.data.assets.findByScope({ role: APT_DEB_KIND, scope: poolPath });
    if (!asset) throw Errors.notFound();
    return serveRegistryBlob(ctx, {
      digest: asset.digest,
      kind: APT_DEB_KIND,
      scope: poolPath,
      contentType: "application/vnd.debian.binary-package",
      redirect: req.method === "GET",
      blocked: () => new Response("package blocked by scan policy", { status: 403 }),
    });
  }

  private async upload(path: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

function notFound(): Response {
  return new Response("not found", { status: 404 });
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

export const aptRegistryPlugin: RegistryPlugin = new AptAdapter();
